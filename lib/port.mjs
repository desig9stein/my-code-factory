// Names the local port of the board server; FACTORY_PORT overrides it.
export const boardPort = () => Number(process.env.FACTORY_PORT || 4317);
