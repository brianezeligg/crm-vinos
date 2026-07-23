// Supabase Edge Function: ai-assistant  (versión Google Gemini — capa gratuita)
// -------------------------------------------------------------------------
// Recibe el historial de chat del frontend, habla con Gemini, y ejecuta
// herramientas de SOLO LECTURA contra tu base para responder con datos reales.
// Las acciones de ESCRITURA (crear seguimiento, cambiar estado) NO se ejecutan
// acá: se devuelven como "propuesta" para que el usuario las confirme en la app.
//
// La API key de Gemini vive como secreto de Supabase (nunca en el navegador).
//
// Sacar la key gratis (sin tarjeta): https://aistudio.google.com/apikey
//
// Deploy:
//   supabase functions deploy ai-assistant
//   supabase secrets set GEMINI_API_KEY=tu-key-aca
//
// SUPABASE_URL y SUPABASE_ANON_KEY ya están disponibles automáticamente
// dentro de las Edge Functions, no hace falta configurarlas.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
// gemini-2.5-flash-lite tiene el cupo diario gratis más alto si necesitás más volumen.
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- Definición de herramientas (formato Gemini function-calling) ----------

const FUNCTION_DECLARATIONS = [
  {
    name: "buscar_clientes",
    description: "Busca clientes por nombre de empresa, contacto o ciudad (coincidencia parcial).",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING", description: "Texto a buscar" } },
      required: ["query"],
    },
  },
  {
    name: "resumen_cliente",
    description: "Devuelve los datos y las últimas 5 entradas del historial de un cliente puntual.",
    parameters: {
      type: "OBJECT",
      properties: { cliente_id: { type: "STRING" } },
      required: ["cliente_id"],
    },
  },
  {
    name: "clientes_seguimiento_pendiente",
    description: "Lista clientes cuyo próximo seguimiento ya venció o vence dentro de N días.",
    parameters: {
      type: "OBJECT",
      properties: { dias: { type: "NUMBER", description: "Ventana en días hacia adelante (default 7)" } },
    },
  },
  {
    name: "resumen_ventas",
    description: "Resume ventas facturadas entre dos fechas: total facturado, unidades vendidas y top vinos.",
    parameters: {
      type: "OBJECT",
      properties: {
        desde: { type: "STRING", description: "Fecha inicio, formato YYYY-MM-DD" },
        hasta: { type: "STRING", description: "Fecha fin, formato YYYY-MM-DD" },
      },
      required: ["desde", "hasta"],
    },
  },
  {
    name: "stock_bajo",
    description: "Lista vinos activos con stock actual por debajo de un umbral (default 5).",
    parameters: {
      type: "OBJECT",
      properties: { umbral: { type: "NUMBER" } },
    },
  },
  {
    name: "proponer_seguimiento",
    description:
      "Propone crear una nueva entrada de seguimiento/nota para un cliente. NO ejecuta el cambio: solo lo deja listo para que el usuario lo confirme en la app.",
    parameters: {
      type: "OBJECT",
      properties: {
        cliente_id: { type: "STRING" },
        via: { type: "STRING", enum: ["Visita", "Llamada", "Email", "WhatsApp", "Otro"] },
        nota: { type: "STRING" },
        proximo: { type: "STRING", description: "Fecha próximo seguimiento, YYYY-MM-DD (opcional)" },
      },
      required: ["cliente_id", "nota"],
    },
  },
  {
    name: "proponer_cambio_estado",
    description:
      "Propone cambiar el estado de un cliente (ej: Nuevo, Activo, Inactivo). NO ejecuta el cambio: solo lo propone para confirmación del usuario.",
    parameters: {
      type: "OBJECT",
      properties: {
        cliente_id: { type: "STRING" },
        estado: { type: "STRING" },
      },
      required: ["cliente_id", "estado"],
    },
  },
];

const WRITE_TOOLS = new Set(["proponer_seguimiento", "proponer_cambio_estado"]);

const SYSTEM_PROMPT =
  "Sos el asistente del CRM de una distribuidora de vinos. Respondé en español, breve y concreto. " +
  "Usá las herramientas disponibles para consultar datos reales antes de responder; nunca inventes " +
  "números ni nombres. Si el usuario pide una acción que cambia datos (crear seguimiento, cambiar " +
  "estado de un cliente), usá la función 'proponer_*' correspondiente en vez de asumir que ya se hizo.";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const { messages } = await req.json();

    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "Falta 'messages' en el body" }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    async function runTool(name: string, args: any) {
      switch (name) {
        case "buscar_clientes": {
          const q = args.query ?? "";
          const { data, error } = await supabase
            .from("clientes")
            .select("id, empresa, contacto, ciudad, estado, telefono, email")
            .or(`empresa.ilike.%${q}%,contacto.ilike.%${q}%,ciudad.ilike.%${q}%`)
            .limit(15);
          if (error) throw error;
          return data;
        }
        case "resumen_cliente": {
          const { data, error } = await supabase
            .from("clientes")
            .select("*")
            .eq("id", args.cliente_id)
            .single();
          if (error) throw error;
          return { ...data, historial: (data.historial || []).slice(0, 5) };
        }
        case "clientes_seguimiento_pendiente": {
          const dias = args.dias ?? 7;
          const limite = new Date();
          limite.setDate(limite.getDate() + dias);
          const { data, error } = await supabase
            .from("clientes")
            .select("id, empresa, contacto, proximo, estado")
            .lte("proximo", limite.toISOString().slice(0, 10))
            .order("proximo", { ascending: true });
          if (error) throw error;
          return data;
        }
        case "resumen_ventas": {
          const { data, error } = await supabase
            .from("ventas")
            .select("*")
            .gte("fecha", args.desde)
            .lte("fecha", args.hasta);
          if (error) throw error;
          const totalFacturado = data.reduce((s: number, v: any) => s + Number(v.total || 0), 0);
          const unidades = data.reduce((s: number, v: any) => s + Number(v.cantidad || 0), 0);
          const porVino: Record<string, number> = {};
          for (const v of data) {
            porVino[v.vino_nombre] = (porVino[v.vino_nombre] || 0) + Number(v.cantidad || 0);
          }
          const topVinos = Object.entries(porVino).sort((a, b) => b[1] - a[1]).slice(0, 5);
          return { totalFacturado, unidades, cantidadVentas: data.length, topVinos };
        }
        case "stock_bajo": {
          const umbral = args.umbral ?? 5;
          const { data, error } = await supabase
            .from("vinos")
            .select("id, nombre, stock_actual")
            .eq("inactivo", false)
            .lte("stock_actual", umbral)
            .order("stock_actual", { ascending: true });
          if (error) throw error;
          return data;
        }
        default:
          throw new Error("Herramienta desconocida: " + name);
      }
    }

    // Convierte nuestro historial simple [{role, content}] al formato "contents" de Gemini
    const contents = messages.map((m: any) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
    }));

    const MAX_TURNS = 6;
    const GEMINI_URL =
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const resp = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
          contents,
        }),
      });

      const data = await resp.json();
      if (data.error) return json({ error: data.error.message }, 500);

      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const functionCallPart = parts.find((p: any) => p.functionCall);

      if (!functionCallPart) {
        const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join("\n");
        return json({ type: "final", text });
      }

      const { name, args } = functionCallPart.functionCall;

      if (WRITE_TOOLS.has(name)) {
        const textSoFar = parts.filter((p: any) => p.text).map((p: any) => p.text).join("\n");
        return json({ type: "action_proposal", text: textSoFar, tool_name: name, input: args });
      }

      let result;
      try {
        result = await runTool(name, args);
      } catch (e) {
        result = { error: String(e) };
      }

      // Agregamos el turno del modelo (con su function call) y la respuesta de la función
      contents.push({ role: "model", parts: [{ functionCall: { name, args } }] });
      contents.push({
        role: "function",
        parts: [{ functionResponse: { name, response: { result } } }],
      });
    }

    return json({ type: "final", text: "No pude terminar de procesar la consulta, probá reformularla." });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
