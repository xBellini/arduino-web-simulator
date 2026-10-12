/**
 * AssemblyScript WASM pacer for the AVR Worker.
 * Computes cycle quanta / wall→cycle targets without touching JS timers in the hot path.
 *
 * Build: npm run build:avr-wasm
 */
export function cyclesForWallMs(wallMs: f64, cpuFreqHz: f64): f64 {
  return Math.floor((wallMs / 1000.0) * cpuFreqHz);
}

/** Cycle quantum from slice budget (ms) and a conservative host-MHz floor. */
export function cycleQuantumForSlice(sliceMs: f64, minHostMhz: f64): i32 {
  const q = i32(Math.floor(sliceMs * minHostMhz * 1000.0));
  return q < 1024 ? 1024 : q;
}

/** Clamp work budget when catching up (ms). */
export function catchupWorkMs(baseMs: f64, catchupMs: f64, behind: bool): f64 {
  if (!behind) return baseMs;
  return baseMs > catchupMs ? baseMs : catchupMs;
}
