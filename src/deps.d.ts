// Tipos de lo que usa la PWA de pilares que no publican .d.ts (@dotrino/remote-agent y una
// subruta de @dotrino/identity). Solo lo que se usa, copiado de su JSDoc. Cuando el pilar traiga
// sus tipos, se borra de aquí.

declare module '@dotrino/remote-agent/client' {
  export class RemoteAgentClient {
    constructor (link: object, opts: { agentPubkey: string, proxyUrl?: string })
    /** La llave de la sesión: existe desde que la máquina contestó el saludo. */
    key: CryptoKey | null
    on (ev: 'message', cb: (payload: any) => void): () => void
    on (ev: 'error', cb: (err: Error & { code?: string }) => void): () => void
    on (ev: 'resumed', cb: () => void): () => void
    connect (): Promise<void>
    send (payload: object): Promise<void>
    close (): Promise<void>
  }
}

declare module '@dotrino/remote-agent/discover' {
  export interface AgentMember { sub: string, label: string, cn: string | null }
  export function listAgentsByLabel (id: unknown, label?: string): Promise<AgentMember[]>
  export function probeAgents (
    client: { on: Function, sendByPubkey: Function },
    subs: string[],
    opts?: { timeoutMs?: number },
  ): Promise<Map<string, { kind: string | null }>>
}

declare module '@dotrino/remote-agent/browser-link' {
  export type BrowserLink =
    | { paired: false, id: import('@dotrino/identity').Identity, expired?: boolean, exp?: number }
    | { paired: true, id: import('@dotrino/identity').Identity, cert: object, iss: string, proxy: string, deviceId: string, scope: string[] }
  export function linkFromIdentity (id: import('@dotrino/identity').Identity): Promise<BrowserLink>
}

declare module '@dotrino/identity/capabilities' {
  /** El id corto de una llave, como lo enseña la bóveda: `AB12-CD34`. */
  export function keyLabel (publickey: string): Promise<string>
}
