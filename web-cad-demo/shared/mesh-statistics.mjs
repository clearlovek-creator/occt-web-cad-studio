/** Neumaier compensated summation. The correction is retained separately so
 * large meshes do not fail a tight average-value consistency check. */
export function addQualityValue(state, value) { const next = state.sum + value; state.compensation += (Math.abs(state.sum) >= Math.abs(value) ? (state.sum - next) + value : (value - next) + state.sum); state.sum = next; }
