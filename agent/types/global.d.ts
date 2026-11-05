// Tipos globales del agente (este archivo no es un módulo: lo de aquí se ve en todos).

/** Lo que llega en un `catch`: casi siempre un `Error`, a veces con `code`, `stderr` o `retryMs`. */
type Thrown = Error & { code?: string, errno?: number, stderr?: string | Buffer, retryMs?: number, cause?: { code?: string } }
