export function conservativeUptime(eligible, unavailable, unknown) {
  return 100 * (eligible - unavailable - unknown) / eligible;
}
