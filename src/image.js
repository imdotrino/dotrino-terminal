/**
 * image.js — una imagen de este aparato, lista para mandarla a la máquina (agentClient.sendImage).
 *
 * La foto de un teléfono pesa varios MB y lo que corre en la consola no necesita tanto: se
 * reduce AQUÍ, antes de salir. Una imagen que ya es pequeña y de un tipo que la máquina admite
 * sale tal cual, sin recomprimir (una captura con texto se lee peor recomprimida).
 */

/** El lado más largo con el que sale una imagen que hubo que reducir. */
export const IMAGE_MAX_SIDE = 2000
/** Por debajo de esto, una imagen de un tipo admitido sale sin tocar. */
export const IMAGE_AS_IS_BYTES = 1024 * 1024
/** Los tipos que la máquina guarda (agent/uploads.js). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Lo que mide una imagen de `w`×`h` para que su lado más largo no pase de `max`. */
export function fitSide (w, h, max = IMAGE_MAX_SIDE) {
  const k = Math.min(1, max / Math.max(w, h))
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

/** ¿Sale tal cual? Un tipo admitido y pequeña. */
export const goesAsIs = (type, size) => IMAGE_TYPES.includes(type) && size <= IMAGE_AS_IS_BYTES

/**
 * Los bytes que se mandan. Lanza `not-image` si el navegador no sabe abrir ese archivo como imagen.
 * @param {Blob} file
 * @returns {Promise<Uint8Array>}
 */
export async function prepareImage (file) {
  if (goesAsIs(file.type, file.size)) return new Uint8Array(await file.arrayBuffer())
  let bmp
  try { bmp = await createImageBitmap(file) } catch (e) {
    throw Object.assign(new Error('this file is not an image the browser can open'), { code: 'not-image' })
  }
  const { w, h } = fitSide(bmp.width, bmp.height)
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  // Fondo blanco: el JPEG no tiene transparencia y sin esto lo transparente sale negro.
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close?.()
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  if (!blob) throw Object.assign(new Error('the browser could not encode the image'), { code: 'not-image' })
  return new Uint8Array(await blob.arrayBuffer())
}

/** La primera imagen de un pegado o de algo soltado encima, o null. */
export function imageIn (transfer) {
  for (const f of transfer?.files || []) if (f.type.startsWith('image/')) return f
  for (const it of transfer?.items || []) if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) return f }
  return null
}
