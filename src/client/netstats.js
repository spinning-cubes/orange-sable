// Client link message counters, incremented in main.js and read by the
// debug overlay to derive TX/RX messages-per-second rates.
export const netStats = {
    tx: 0, // messages sent client -> server
    rx: 0  // messages received server -> client
};
