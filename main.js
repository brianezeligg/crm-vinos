const { app, BrowserWindow } = require('electron')

function createWindow() {

  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900
  })

  mainWindow.loadFile('index.html')
// mainWindow.webContents.openDevTools();

  mainWindow.removeMenu()
}

app.whenReady().then(() => {
  createWindow()
})