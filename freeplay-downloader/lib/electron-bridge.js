// Minimal bridge so non-Electron modules can reach the Electron API when the
// app runs under Electron. server.js also runs under plain Node (npm start),
// so modules cannot import electron directly.

const electronBridge = {
  electron: null,
  init(electron) {
    this.electron = electron;
  },
  available() {
    return Boolean(this.electron && this.electron.BrowserWindow);
  }
};

export { electronBridge };
export default electronBridge;
