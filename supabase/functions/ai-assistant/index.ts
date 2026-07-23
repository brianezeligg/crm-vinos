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
    name: "buscar_vinos",
    description:
      "Busca y filtra vinos activos por nombre, bodega, varietal y/o rango de precio de venta. Usar para cualquier pregunta sobre el catálogo de vinos (qué tenés, cuánto sale, de qué bodega, etc).",
    parameters: {
      type: "OBJECT",
      properties: {
        nombre: { type: "STRING", description: "Coincidencia parcial de nombre (opcional)" },
        bodega: { type: "STRING", description: "Coincidencia parcial de bodega (opcional)" },
        varietal: { type: "STRING", description: "Coincidencia parcial de varietal, ej: Malbec (opcional)" },
        precio_min: { type: "NUMBER", description: "Precio de venta mínimo (opcional)" },
        precio_max: { type: "NUMBER", description: "Precio de venta máximo (opcional)" },
      },
    },
  },
  {
    name: "ranking_clientes_seguimientos",
    description: "Ordena a los clientes según cuántas entradas de historial (visitas, llamadas, ventas, etc.) tienen registradas, de mayor a menor.",
    parameters: {
      type: "OBJECT",
      properties: { limite: { type: "NUMBER", description: "Cantidad de resultados (default 10)" } },
    },
  },
  {
    name: "ranking_clientes_facturacion",
    description: "Ordena a los clientes según el total facturado en ventas dentro de un rango de fechas, de mayor a menor.",
    parameters: {
      type: "OBJECT",
      properties: {
        desde: { type: "STRING", description: "Fecha inicio, YYYY-MM-DD" },
        hasta: { type: "STRING", description: "Fecha fin, YYYY-MM-DD" },
        limite: { type: "NUMBER", description: "Cantidad de resultados (default 10)" },
      },
      required: ["desde", "hasta"],
    },
  },
  {
    name: "ranking_vinos_mas_vendidos",
    description: "Ordena los vinos según unidades vendidas dentro de un rango de fechas, de mayor a menor.",
    parameters: {
      type: "OBJECT",
      properties: {
        desde: { type: "STRING", description: "Fecha inicio, YYYY-MM-DD" },
        hasta: { type: "STRING", description: "Fecha fin, YYYY-MM-DD" },
        limite: { type: "NUMBER", description: "Cantidad de resultados (default 10)" },
      },
      required: ["desde", "hasta"],
    },
  },
  {
    name: "resumen_general",
    description: "Devuelve un resumen general del CRM: total de clientes por estado, total de vinos activos/inactivos, y facturación histórica total.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "clientes_por_filtro",
    description: "Lista clientes filtrando por estado, país, ciudad y/o tipo de cocina (cualquier combinación, todos opcionales).",
    parameters: {
      type: "OBJECT",
      properties: {
        estado: { type: "STRING", description: "Ej: Nuevo, Interesado, Contactado, Cerrado, Inactivo" },
        pais: { type: "STRING" },
        ciudad: { type: "STRING" },
        cocina: { type: "STRING" },
      },
    },
  },
  {
    name: "buscar_en_notas",
    description:
      "Busca una palabra o frase dentro de las notas del historial de TODOS los clientes (visitas, llamadas, seguimientos, etc.). Útil para preguntas como '¿qué cliente dijo tal cosa?'.",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING", description: "Palabra o frase a buscar en las notas" } },
      required: ["query"],
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
        case "buscar_vinos": {
          let q = supabase
            .from("vinos")
            .select("id, nombre, bodega, varietal, precio_venta, stock_actual")
            .eq("inactivo", false);
          if (args.nombre) q = q.ilike("nombre", `%${args.nombre}%`);
          if (args.bodega) q = q.ilike("bodega", `%${args.bodega}%`);
          if (args.varietal) q = q.ilike("varietal", `%${args.varietal}%`);
          if (args.precio_min != null) q = q.gte("precio_venta", args.precio_min);
          if (args.precio_max != null) q = q.lte("precio_venta", args.precio_max);
          const { data, error } = await q.order("precio_venta", { ascending: true }).limit(50);
          if (error) throw error;
          return data;
        }
        case "buscar_en_notas": {
          const query = (args.query || "").toLowerCase();
          const { data, error } = await supabase.from("clientes").select("id, empresa, contacto, historial");
          if (error) throw error;
          const matches: any[] = [];
          for (const c of data) {
            for (const h of c.historial || []) {
              if (h.nota && String(h.nota).toLowerCase().includes(query)) {
                matches.push({
                  clienteId: c.id,
                  empresa: c.empresa,
                  contacto: c.contacto,
                  fecha: h.fecha,
                  nota: h.nota,
                });
              }
            }
          }
          matches.sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")));
          return matches.slice(0, 20);
        }
        case "ranking_clientes_seguimientos": {
          const limite = args.limite ?? 10;
          const { data, error } = await supabase.from("clientes").select("id, empresa, contacto, historial");
          if (error) throw error;
          const ranked = data
            .map((c: any) => ({
              clienteId: c.id,
              empresa: c.empresa,
              contacto: c.contacto,
              cantidadSeguimientos: (c.historial || []).length,
            }))
            .sort((a: any, b: any) => b.cantidadSeguimientos - a.cantidadSeguimientos)
            .slice(0, limite);
          return ranked;
        }
        case "ranking_clientes_facturacion": {
          const limite = args.limite ?? 10;
          const { data, error } = await supabase
            .from("ventas")
            .select("cliente_id, cliente_nombre, total")
            .gte("fecha", args.desde)
            .lte("fecha", args.hasta);
          if (error) throw error;
          const porCliente: Record<string, { clienteId: string; empresa: string; total: number }> = {};
          for (const v of data) {
            const key = v.cliente_id;
            if (!porCliente[key]) porCliente[key] = { clienteId: key, empresa: v.cliente_nombre, total: 0 };
            porCliente[key].total += Number(v.total || 0);
          }
          return Object.values(porCliente).sort((a, b) => b.total - a.total).slice(0, limite);
        }
        case "ranking_vinos_mas_vendidos": {
          const limite = args.limite ?? 10;
          const { data, error } = await supabase
            .from("ventas")
            .select("vino_nombre, cantidad")
            .gte("fecha", args.desde)
            .lte("fecha", args.hasta);
          if (error) throw error;
          const porVino: Record<string, number> = {};
          for (const v of data) {
            porVino[v.vino_nombre] = (porVino[v.vino_nombre] || 0) + Number(v.cantidad || 0);
          }
          return Object.entries(porVino)
            .map(([vino, cantidad]) => ({ vino, cantidad }))
            .sort((a, b) => b.cantidad - a.cantidad)
            .slice(0, limite);
        }
        case "resumen_general": {
          const [{ data: clientesData, error: errC }, { data: vinosData, error: errV }, { data: ventasData, error: errVe }] =
            await Promise.all([
              supabase.from("clientes").select("estado"),
              supabase.from("vinos").select("inactivo"),
              supabase.from("ventas").select("total"),
            ]);
          if (errC) throw errC;
          if (errV) throw errV;
          if (errVe) throw errVe;
          const clientesPorEstado: Record<string, number> = {};
          for (const c of clientesData) clientesPorEstado[c.estado || "Sin estado"] = (clientesPorEstado[c.estado || "Sin estado"] || 0) + 1;
          const vinosActivos = vinosData.filter((v: any) => !v.inactivo).length;
          const vinosInactivos = vinosData.filter((v: any) => v.inactivo).length;
          const facturacionHistorica = ventasData.reduce((s: number, v: any) => s + Number(v.total || 0), 0);
          return {
            totalClientes: clientesData.length,
            clientesPorEstado,
            vinosActivos,
            vinosInactivos,
            facturacionHistoricaTotal: facturacionHistorica,
          };
        }
        case "clientes_por_filtro": {
          let q = supabase.from("clientes").select("id, empresa, contacto, estado, pais, ciudad, cocina");
          if (args.estado) q = q.ilike("estado", `%${args.estado}%`);
          if (args.pais) q = q.ilike("pais", `%${args.pais}%`);
          if (args.ciudad) q = q.ilike("ciudad", `%${args.ciudad}%`);
          if (args.cocina) q = q.ilike("cocina", `%${args.cocina}%`);
          const { data, error } = await q.limit(50);
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
        const text = parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("\n");
        return json({ type: "final", text });
      }

      const { name, args } = functionCallPart.functionCall;

      if (WRITE_TOOLS.has(name)) {
        const textSoFar = parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("\n");
        return json({ type: "action_proposal", text: textSoFar, tool_name: name, input: args });
      }

      let result;
      try {
        result = await runTool(name, args);
      } catch (e) {
        result = { error: String(e) };
      }

      // Reenviamos el turno del modelo tal cual lo devolvió (preserva thought_signature)
      contents.push(candidate.content);
      contents.push({
        role: "user",
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
