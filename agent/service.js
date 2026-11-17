/**
 * service.js — el agente como SERVICIO del usuario: arranca solo con la máquina.
 *
 * Sin esto el agente lo levanta la primera ventana que se abre (`dotrino-terminal`), así que
 * tras encender la máquina nadie puede abrir sus consolas desde otro aparato hasta que alguien
 * se siente delante. `dotrino-terminal service install` lo deja a cargo del sistema.
 *
 * La pieza es común (`@dotrino/remote-agent/service`, la usa también el escritorio remoto);
 * aquí solo va qué agente es. En Linux, systemd de usuario: este agente no necesita la sesión
 * gráfica, así que con «linger» arranca al encender, antes de que nadie inicie sesión. Los
 * nombres (unidad, LaunchAgent, entrada de `Run`) son los de siempre: un servicio ya instalado
 * sigue siendo el mismo.
 */
import { makeService, supervise as superviseAgent, RUN_KEY, RESTART_MS, supervisorPidFile } from '@dotrino/remote-agent/service'

/** @param {string} name */
const agentArgs = (name) => ['--name', name, '--local']

const svc = makeService({ id: 'terminal-agent', title: 'Dotrino Terminal agent', runPrefix: 'DotrinoTerminalAgent', agentArgs })

export const {
  installService, uninstallService, serviceStatus, startService, superviseCommand,
  unitText, plistText, unitName, unitPath, plistLabel, plistPath, runValue, runCommand
} = svc
export { RUN_KEY, RESTART_MS, supervisorPidFile }

/**
 * El supervisor (Windows): levanta el agente del perfil y lo vuelve a levantar cada vez que sale.
 * @param {{ name: string, dir: string, node?: string, cli: string, spawn?: typeof import('node:child_process').spawn }} o
 */
export const supervise = (o) => superviseAgent({ ...o, args: agentArgs(o.name) })

export default { supervise, runCommand, runValue, RUN_KEY, startService, installService, uninstallService, serviceStatus, unitText, plistText, unitName, unitPath, plistLabel, plistPath }
