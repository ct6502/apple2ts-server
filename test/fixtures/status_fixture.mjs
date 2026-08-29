export const statusFixture = {
  machine: {
    runMode: -2,
    speedMode: 1,
    machineName: "APPLE2EE",
    ramWorksKb: 64,
    isDebugging: true,
    showDebugTab: false,
    textPage: "READY",
    softSwitches: {
      TEXT: false,
      MIXED: false,
      PAGE2: false,
      HIRES: true,
    },
    machineState: {
      PC: 768,
      Accum: 65,
      XReg: 1,
      YReg: 2,
      StackPtr: 255,
      flagIRQ: 0,
      flagNMI: false,
      PStatus: 32,
      cycleCount: 1234,
    },
  },
  drives: [],
}
