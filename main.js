const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs   = require('fs')

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  mainWindow.loadFile('index.html')
  // mainWindow.webContents.openDevTools()
  mainWindow.removeMenu()
}

// Mantener el proceso vivo en Windows/Linux
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.whenReady().then(() => {
  createWindow()

  // Para macOS: recrear ventana si se hace click en el dock
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// ── Backup a disco ──────────────────────────────────────────────────────────
ipcMain.handle('save-backup', (event, jsonData) => {
  try {
    const backupDir = path.join(__dirname, 'backup')
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir)

    const ahora    = new Date()
    const fecha    = ahora.toISOString().slice(0, 10)
    const hora     = ahora.toTimeString().slice(0, 8).replace(/:/g, '-')
    const filename = `crm-backup-${fecha}_${hora}.json`
    const filepath = path.join(backupDir, filename)

    fs.writeFileSync(filepath, jsonData, 'utf8')
    console.log('Backup guardado:', filepath)
    return { ok: true, filename }
  } catch (err) {
    console.error('Error guardando backup:', err)
    return { ok: false, error: err.message }
  }
})
