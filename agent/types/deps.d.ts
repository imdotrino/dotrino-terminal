// Tipos de los pilares que usa el agente y no publican .d.ts (@dotrino/remote-agent, @dotrino/vault,
// @dotrino/update y una subruta de @dotrino/identity). Solo lo que se usa, copiado de su JSDoc.
// Cuando el pilar traiga sus tipos, se borra de aquí.

/** El enlace de un aparato con su bóveda, como lo guarda @dotrino/remote-agent (`link.json`). */
interface DotrinoDeviceLink {
  device: { publickey: string, privateJwk: import('node:crypto').JsonWebKey, publicJwk?: import('node:crypto').JsonWebKey }
  cert: { seq?: number, exp?: number, scope?: string[], [k: string]: unknown }
  iss: string
  proxy?: string
  label?: string
  at?: number
  acta?: object
  [k: string]: unknown
}

declare module '@dotrino/remote-agent/link' {
  export function dataDir (name?: string): string
  /** null si no existe; lanza `link-unreadable` si existe y no se puede leer. */
  export function loadLink (dir?: string): DotrinoDeviceLink | null
  export function parseQr (text: string): Promise<object | string>
  export function enroll (args: {
    qr: object | string
    label?: string
    dir?: string
    ns?: string | null
    onChallenge?: (c: { deviceId: string, code: string }) => void
    timeoutMs?: number
  }): Promise<DotrinoDeviceLink>
  /** El enlace como lo esperan `RemoteAgentClient` y `ContentClient`. */
  export function clientLink (link: DotrinoDeviceLink, opts?: { dir?: string }): { id: object, cert: object, iss: string, proxy: string }
}

declare module '@dotrino/remote-agent/instances' {
  export const DEFAULT_NAME: string
  export function isValidName (n: unknown): n is string
  export function instancesRoot (kind: string): string
  /** Nombres de las instancias enlazadas (las que tienen `link.json`). */
  export function listInstances (kind: string): string[]
  export function resolveInstance (kind: string, name?: string | null): { name: string, dir: string }
  /** Candado de la instancia; devuelve cómo soltarlo. */
  export function lockInstance (dir: string): () => void
}

declare module '@dotrino/remote-agent/client' {
  export class RemoteAgentClient {
    constructor (link: object, opts: { agentPubkey: string, proxyUrl?: string, trustedActa?: () => object | null })
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
  /** `fresh`: pedir el acta a la bóveda en vez de usar la guardada. */
  export function listAgentsByLabel (id: unknown, label?: string, opts?: { fresh?: boolean }): Promise<AgentMember[]>
  export function probeAgents (
    client: { on: Function, sendByPubkey: Function },
    subs: string[],
    opts?: { timeoutMs?: number },
  ): Promise<Map<string, { kind: string | null }>>
}

declare module '@dotrino/remote-agent/agent' {
  /** Una sesión cifrada con un aparato autorizado. */
  export interface AgentSession {
    sid: string
    /** El token del cliente en el proxio. */
    from: string
    /** La pubkey del aparato cliente. */
    device: string
    on (ev: 'message', cb: (payload: any) => void): void
    on (ev: 'close', cb: () => void): void
    send (payload: object): Promise<void>
    /** ¿Va por un canal directo (WebRTC) ahora mismo? */
    direct (): boolean
    /** Espera a que abra el canal directo, como mucho `ms`. */
    whenDirect (ms?: number): Promise<boolean>
  }
  export interface RemoteAgent {
    machine: string
    machineId: string
    master: string
    client: import('@dotrino/proxy-client').WebSocketProxyClient
    reportIncident (i: { kind: string, about: string, tries: number }): Promise<{ id: string | null, approvers: number, blocked: boolean }>
    close (): void
  }
  export function startRemoteAgent (opts?: {
    dir?: string
    proxyUrl?: string
    quiet?: boolean
    label?: string
    sessionTtlMs?: number
    onRevoked?: () => void
    onSession?: (session: AgentSession) => void
    product?: string
    version?: string
    needs?: string[]
  }): Promise<RemoteAgent>
}

declare module '@dotrino/identity/capabilities' {
  /** El id corto de una llave, como lo enseña la bóveda: `AB12-CD34`. */
  export function keyLabel (publickey: string): Promise<string>
}

declare module '@dotrino/vault/device-info' {
  export interface DeviceInfo { id: string, vault: string | null, scope: string[], record: number | null, legacyExpires: number | null, proxy: string | null, publickey: string, [k: string]: unknown }
  export function deviceInfo (link: { device?: { publickey?: string }, cert?: object, iss?: string, proxy?: string }, extra?: Record<string, unknown>): Promise<DeviceInfo>
  export function formatDeviceInfo (info: DeviceInfo): string
}

declare module '@dotrino/vault/service' {
  export interface UpdateHooks {
    mayUpdate: (u: { version: string, from?: string }) => Promise<boolean>
    onUpdated: (u: { version: string, from?: string }) => Promise<void>
    onNeedsRoot: (u: { version: string, from?: string }) => Promise<void>
  }
  export function vaultUpdateHooks (o: { product: string, log?: (m: string) => void, dir?: string, proxyUrl?: string, masterPubkey?: string, device?: object, cert?: object }): UpdateHooks
}

declare module '@dotrino/update' {
  export type LatestResult =
    | { ok: true, version: string, source: 'npm', pkg: string }
    | { ok: true, version: string, source: 'github', repo: string, assets: { name: string, url: string, size?: number }[], url: string }
    | { ok: false, reason: string, code?: string }
  export function latestVersion (o: { source?: string, repo?: string, pkg?: string, tagPrefix?: string, product?: string, version?: string, timeoutMs?: number }): Promise<LatestResult>
  /** ¿`a` es más nueva que `b`? */
  export function isNewer (a: string, b: string): boolean
}

declare module '@dotrino/update/fetch' {
  export interface ReleaseAsset { name: string, url: string, size?: number }
  export function pickAsset (assets: ReleaseAsset[], match: { kind: string, re: RegExp, when?: () => boolean }[]):
    | { ok: true, asset: ReleaseAsset, kind: string }
    | { ok: false, reason: string }
  export function fetchVerified (asset: ReleaseAsset, opts?: { repo?: string, product?: string, version?: string, dir?: string | null }):
    Promise<({ ok: true, out: string } | { ok: false, code?: string, reason: string }) & { file?: string }>
}

declare module '@dotrino/update/npm' {
  export function watchSelfUpdateNpm (o: {
    pkg: string
    current: string
    repo?: string
    /** El tag de la release de una versión (`agent-v1.2.3`). */
    tag?: (version: string) => string
    dir?: string
    mayUpdate?: (u: { version: string, from?: string }) => Promise<boolean>
    onUpdated?: (u: { version: string, from?: string }) => Promise<void>
    onNeedsRoot?: (u: { version: string, from?: string }) => Promise<void>
    onInstalled?: (r: { version: string, restart: boolean }) => void
    onResult?: (r: object) => void
    log?: (m: string) => void
  }): () => void
  export function updatePrefsCommand (args?: string[], opts?: { dir?: string, lang?: string }): {
    handled: boolean
    ok: boolean
    text: string
    prefs?: { approval: boolean, notify: boolean }
  }
  export function updateStatusText (o: { dir?: string, current: string, lang?: string, now?: () => number }): string
}

declare module '@dotrino/update/notice' {
  /** Imprime por stderr si hay versión nueva (una vez al día). Devuelve si imprimió algo. */
  export function printUpdateNotice (opts?: { current?: string, source?: string, pkg?: string, product?: string, how?: string }): Promise<boolean>
}
