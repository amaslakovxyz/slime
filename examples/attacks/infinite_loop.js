// Attack: burn the CPU forever — the sandbox deadline (500 ms) interrupts it.
export function handler(input, db, ctx) {
  while (true) {}
}
