import type { ChatMessage } from '../chatbot'
import { computeLineDiff, type CodeDiff, type DiffLine } from '../diff'

// Reexportamos el diff (ahora en un módulo propio) para no romper importaciones
// existentes que lo consumían desde el agente.
export { computeLineDiff }
export type { CodeDiff, DiffLine }

/**
 * Agente de código para el playground. Convierte al asistente de IA en un mini
 * "Claude Code": según lo que pida el usuario, o bien responde (pregunta), o bien
 * actúa sobre el código del editor y lo ejecuta, reintentando si falla.
 *
 * Diseñado para modelos pequeños (0.5B–2B) que no siguen protocolos: el HARNESS
 * decide el modo de forma determinista (responder / ejecutar / editar) y al modelo
 * solo se le pide una tarea simple por llamada (contestar en Markdown, o devolver
 * el fichero completo en un bloque de código). Aplicar la edición, ejecutar,
 * reintentar con el error y redactar el resumen lo hace el harness. Si el modelo
 * devuelve basura (restos de protocolo, nada, código parcial), se detecta y se
 * reintenta o se dice la verdad, nunca se muestra tal cual.
 */

export interface AgentRunResult {
  /** Salida de consola formateada (una línea por entrada). */
  output: string
  /** true SOLO si hubo un error de ejecución no capturado (no cuenta console.error). */
  hasError: boolean
}

/** Puente hacia el editor y el runner del playground. Lo implementa main.ts. */
export interface AgentBridge {
  getCode(): string
  setCode(code: string): void
  run(): Promise<AgentRunResult>
  /** Lenguaje actual para los bloques de código ('javascript' | 'typescript'). */
  language?(): string
  /** Formatea el código con Prettier (transformación determinista). Opcional. */
  format?(code: string): Promise<string>
}

export interface AgentEditInfo {
  added: number
  removed: number
  note?: string
  lines: DiffLine[]
}

export interface AgentStepHandle {
  update(detail: string, state?: 'ok' | 'error'): void
}

/** Callbacks de UI. Los implementa main.ts para pintar pasos y la respuesta final. */
export interface AgentUI {
  /** Pinta una tarjeta de edición con el diff aplicado (+añadidas / −borradas). */
  edit(info: AgentEditInfo): void
  /** Pinta una tarjeta de ejecución y devuelve un updater. */
  run(): AgentStepHandle
  /** Pinta la respuesta final del asistente (markdown). */
  finalAnswer(markdown: string): void
  /** Actualiza el indicador de estado ("Pensando…", "Trabajando…"). */
  status(text: string): void
  /** Oculta el indicador de estado. */
  clearStatus(): void
}

/** Un intercambio anterior de la conversación (da continuidad a las respuestas). */
export interface AgentExchange {
  user: string
  assistant: string
}

export interface AgentGenerationOptions {
  temperature?: number
  maxTokens?: number
}

export interface AgentDeps {
  generate(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
    options?: AgentGenerationOptions,
  ): Promise<string>
  bridge: AgentBridge
  ui: AgentUI
  /** Máximo de intentos de edición (cada uno es una llamada al modelo). */
  maxSteps?: number
  /** Contexto extra para el modelo (p. ej. la selección del editor). No cuenta para detectar la intención. */
  context?: string
  /** Últimos intercambios de la conversación, del más antiguo al más reciente. */
  history?: AgentExchange[]
}

// ---------------------------------------------------------------------------
// Transformaciones deterministas (las ejecuta el harness, no el modelo).
// Un modelo pequeño reescribiendo el fichero entero es poco fiable; para tareas
// mecánicas (quitar comentarios, formatear) hacerlo nosotros acierta siempre.
// ---------------------------------------------------------------------------

/** ¿Puede aparecer una regex justo después de este carácter significativo? */
function regexCanFollow(prev: string): boolean {
  if (prev === '') return true
  // Tras un identificador, número, `)` `]` o `.` un `/` es división, no regex.
  return !/[\w$)\]]/.test(prev)
}

/**
 * Elimina comentarios `//` y `/* *\/` de código JS/TS respetando strings,
 * template literals y (heurísticamente) expresiones regulares. Limpia espacios
 * finales y colapsa las líneas en blanco que deja al borrar comentarios completos.
 */
export function stripComments(code: string): string {
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 'regex'
  let state: State = 'code'
  let out = ''
  let lastSig = ''
  let i = 0
  const n = code.length

  while (i < n) {
    const c = code[i]
    const c2 = code[i + 1] ?? ''

    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line'
        i += 2
        continue
      }
      if (c === '/' && c2 === '*') {
        state = 'block'
        i += 2
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        out += c
        state = c === '"' ? 'dq' : c === "'" ? 'sq' : 'tpl'
        lastSig = c
        i++
        continue
      }
      if (c === '/' && regexCanFollow(lastSig)) {
        out += c
        state = 'regex'
        lastSig = c
        i++
        continue
      }
      out += c
      if (!/\s/.test(c)) lastSig = c
      i++
      continue
    }

    if (state === 'line') {
      if (c === '\n') {
        out += c
        state = 'code'
      }
      i++
      continue
    }

    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code'
        i += 2
        continue
      }
      // Conservamos los saltos de línea del comentario para no fusionar líneas.
      if (c === '\n') out += c
      i++
      continue
    }

    // Strings y regex: copiamos tal cual y respetamos los escapes.
    out += c
    if (c === '\\') {
      out += code[i + 1] ?? ''
      i += 2
      continue
    }
    if (
      (state === 'dq' && c === '"') ||
      (state === 'sq' && c === "'") ||
      (state === 'tpl' && c === '`') ||
      (state === 'regex' && c === '/')
    ) {
      state = 'code'
    }
    i++
  }

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n')
}

// ---------------------------------------------------------------------------
// Detección de intención (heurística, ES + EN). El harness decide el modo: un
// modelo pequeño enruta muy mal (contesta "final" o "run" en vez de actuar).
// ---------------------------------------------------------------------------
// Imperativos e infinitivos (los infinitivos aparecen en peticiones educadas:
// "¿puedes añadir…?").
const EDIT_INTENT_RE =
  /\b(quita(?:r)?|elimina(?:r)?|borra(?:r)?|suprim(?:e|ir)|remove|delete|strip|arregla(?:r)?|corrig(?:e)|corregir|repara(?:r)?|fix|refactor(?:iza(?:r)?)?|formatea(?:r)?|format|reempl(?:aza|azar)|replace|sustitu(?:ye|ir)|renombra(?:r)?|rename|a[ñn]ad(?:e|ir)|agrega(?:r)?|add|inserta(?:r)?|insert|implementa(?:r)?|implement|extra(?:e|er)|extract|optimiza(?:r)?|optimize|tradu(?:ce|cir)|translate|cambia(?:r)?|change|conviert(?:e)|convertir|convert|crea(?:r)?|create|genera(?:r)?|generate|escrib(?:e|ir)|write|haz|hacer|make|mueve|mover|move|actualiza(?:r)?|update|simplifica(?:r)?|simplify|mejora(?:r)?|improve|completa(?:r)?|complete|termina(?:r)?|finish)\b/i

// Preguntas ("¿cómo funciona…?", "why…", "explain…"): aunque contengan un verbo
// de edición ("¿cómo puedo añadir…?") el usuario pide una explicación.
const QUESTION_LEAD_RE =
  /^[¿¡\s]*(c[oó]mo|por\s*qu[eé]|qu[eé]|cu[aá]l(?:es)?|cu[aá]ndo|d[oó]nde|para\s+qu[eé]|explica|expl[ií]ca(?:me|lo)|how|why|what|which|when|where|is|are|does|do|explain)\b/i

// Peticiones educadas en forma de pregunta ("¿puedes añadir…?", "can you fix…")
// sí piden un cambio.
const POLITE_REQUEST_RE = /\b(puedes|podr[ií]as|quieres|can you|could you|would you|please|por favor)\b/i

const RUN_INTENT_RE =
  /\b(ejec[uú]ta(?:r|lo)?|c[oó]rre(?:r|lo)|run(?:\s+it)?|pru[eé]ba(?:lo)?|test\s+it|qu[eé]\s+(?:imprime|devuelve|sale|muestra|da)|what\s+does\s+it\s+(?:print|output|return|log|show))\b/i

export type AgentMode = 'answer' | 'run' | 'edit'

// Saludos y agradecimientos sueltos. Con el código en el prompt, un modelo pequeño
// responde a "Hola" inventándose que lo ha modificado; para estos no se envía.
const SMALL_TALK_RE =
  /^[¡¿\s]*(?:hola|holi|hey|hi|hello|buenas(?:\s+(?:tardes|noches))?|buenos\s+d[ií]as|good\s+(?:morning|afternoon|evening)|qu[eé]\s+tal|gracias|muchas\s+gracias|thanks|thank\s+you|ok(?:ay)?|vale|genial|perfecto|great|cool)(?:\s+\S+)?[\s!.,?¡¿😀-🙏]*$/iu

// Los modelos pequeños ignoran "responde en el idioma del usuario", pero sí siguen
// un idioma nombrado explícitamente. Basta con distinguir español de inglés.
const SPANISH_HINT_RE =
  /[¿¡ñáéíóú]|\b(?:el|la|los|las|que|qu[eé]|de|del|y|es|un|una|por|para|con|haz|hola|gracias|c[oó]digo|funci[oó]n|a[ñn]ade|arregla|quita|imprime|explica)\b/i

export function detectUserLanguage(userMessage: string): 'Spanish' | 'English' {
  return SPANISH_HINT_RE.test(userMessage) ? 'Spanish' : 'English'
}

export function isSmallTalk(userMessage: string): boolean {
  return SMALL_TALK_RE.test(userMessage.trim())
}

export function isEditIntent(userMessage: string): boolean {
  return EDIT_INTENT_RE.test(userMessage)
}

/** Decide qué hace el harness con el mensaje: responder, ejecutar y comentar, o editar. */
export function detectAgentMode(userMessage: string): AgentMode {
  const message = userMessage.trim()
  const isQuestion = QUESTION_LEAD_RE.test(message) && !POLITE_REQUEST_RE.test(message)
  if (isEditIntent(message) && !isQuestion) return 'edit'
  if (RUN_INTENT_RE.test(message)) return 'run'
  return 'answer'
}

// Otros verbos de edición que, si aparecen, indican que la petición NO es una
// transformación mecánica pura (hay trabajo extra que sí necesita al modelo).
const OTHER_WORK_RE =
  /\b(a[ñn]ade|agrega|add|arregla|corrige|fix|refactor(?:iza)?|renombra|rename|reempl(?:aza|azar)|replace|implementa|implement|traduce|translate|cambia|change|convierte|convert|optimiza|optimize|extrae|extract)\b/i

/**
 * Detecta peticiones que son una transformación DETERMINISTA pura (quitar
 * comentarios, formatear). En esos casos el harness la ejecuta él mismo sin pasar
 * por el modelo, que es el eslabón poco fiable. Devuelve null si la petición mezcla
 * otro trabajo (p.ej. "quita los comentarios Y añade tipos") -> ahí sí usamos el modelo.
 */
export function detectDeterministicIntent(userMessage: string): 'strip-comments' | 'format' | null {
  const m = userMessage.toLowerCase()
  const mentionsComments = /\bcomentarios?\b|\bcomments?\b/.test(m)
  const removeVerb = /\b(quita(?:r)?|elimina(?:r)?|borra(?:r)?|suprime|remove|delete|strip|sin)\b/.test(m)
  const otherWork = OTHER_WORK_RE.test(m)

  if (mentionsComments && removeVerb && !otherWork) return 'strip-comments'

  const formatVerb = /\b(formatea(?:r)?|format|prettifica|prettify|prettier|indenta(?:r)?)\b/.test(m)
  if (formatVerb && !mentionsComments && !otherWork) return 'format'

  return null
}

// ---------------------------------------------------------------------------
// Limpieza de la salida del modelo
// ---------------------------------------------------------------------------

// Palabras sueltas que un modelo pequeño emite cuando intenta "seguir un
// protocolo" en vez de contestar. Nunca son una respuesta válida por sí solas.
const PROTOCOL_WORD_RE = /^(?:final|run|write|answer|response|respuesta|output|done|ok|assistant|action|edit)\s*[:.]?$/i

/**
 * Quita razonamiento (`<think>`), etiquetas de protocolo y prefijos de rol que
 * algunos modelos cuelan en la respuesta, y las líneas que solo son una palabra
 * de protocolo ("final", "run"…).
 */
// Un modelo pequeño a veces sigue escribiendo la conversación e inventa el
// siguiente turno del usuario ("User message: …"): todo eso sobra.
const INVENTED_TURN_RE = /^\s*(?:user message|user|usuario|human|requested change|current code)\s*:/im

export function cleanModelText(raw: string): string {
  const inventedTurn = raw.match(INVENTED_TURN_RE)
  const ownTurn = inventedTurn?.index ? raw.slice(0, inventedTurn.index) : raw
  return ownTurn
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<\/?(?:action|answer|response|final|output)[^>]*>/gi, '')
    .replace(/^\s*(?:assistant|asistente|ai|response|respuesta|answer)\s*:\s*/i, '')
    .split('\n')
    .filter((line) => !PROTOCOL_WORD_RE.test(line.trim()))
    .join('\n')
    .trim()
}

// Metafrases con las que un modelo pequeño anuncia que va a repetir su respuesta
// ("Por lo tanto, la respuesta al usuario sería:"). Todo lo que sigue es eco.
const ECHO_LEAD_RE =
  /^\s*(?:(?:por lo tanto|así que|en resumen|therefore|so),?\s*)?(?:la respuesta(?: final)?(?: al usuario)?|mi respuesta|the (?:final )?(?:answer|response|reply)(?: to the user)?|my (?:answer|response))\s+(?:ser[ií]a|es|would be|is)\s*:?\s*$/im

function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim()
}

// Etiquetas que un modelo pequeño copia de las instrucciones ("Change:",
// "Sentence:") en lugar de escribir directamente la frase.
const PROSE_LABEL_RE =
  /^\s*(?:change|changes|sentence|explanation|description|summary|note|answer|response|cambio|cambios|frase|explicaci[oó]n|descripci[oó]n|resumen|nota|respuesta)\s*:\s*/i

/** Explicación de una edición: la primera frase útil, sin etiquetas ni eco. */
export function cleanEditProse(prose: string): string {
  const paragraph = removeEchoes(prose)
    .split('\n')
    .map((line) => line.replace(PROSE_LABEL_RE, '').trim())
    .find((line) => isMeaningfulAnswer(line))
  return paragraph ?? ''
}

/** Quita el eco: la repetición tras una metafrase y los párrafos duplicados. */
export function removeEchoes(text: string): string {
  const echoLead = text.match(ECHO_LEAD_RE)
  const beforeEcho = echoLead?.index ? text.slice(0, echoLead.index) : text
  const seen = new Set<string>()
  return beforeEcho
    .split(/\n{2,}/)
    .filter((paragraph) => {
      const key = normalizeForComparison(paragraph)
      if (!key) return false
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join('\n\n')
    .trim()
}

/** ¿`text` repite (casi) literalmente `previous`? Proporción de palabras compartidas. */
export function isRepeatOf(text: string, previous: string | undefined): boolean {
  if (!previous) return false
  const words = (value: string) => new Set(normalizeForComparison(value).split(' ').filter((word) => word.length > 3))
  const current = words(text)
  const earlier = words(previous)
  if (current.size < 8 || earlier.size < 8) return false
  let shared = 0
  for (const word of current) if (earlier.has(word)) shared++
  return shared / current.size > 0.8
}

/** ¿El texto (ya limpio) es una respuesta de verdad y no un resto vacío? */
export function isMeaningfulAnswer(text: string): boolean {
  return text.replace(/[\s`*_#>.\-]/g, '').length >= 2
}

/**
 * Extrae el fichero completo que devuelve el modelo y la explicación que lo
 * acompaña. Si hay varios bloques (p. ej. un fragmento y luego el fichero), se
 * queda con el más largo: es el que contiene el fichero entero.
 */
export function extractEditedCode(raw: string): { code: string | null; prose: string } {
  const text = cleanModelText(raw)
  const blocks = [...text.matchAll(/```[a-zA-Z0-9_-]*[^\S\r\n]*\r?\n([\s\S]*?)```/g)]
  if (blocks.length === 0) return { code: null, prose: text }
  const longest = blocks.reduce((best, block) => (block[1].length > best[1].length ? block : best))
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim()
  return { code: longest[1].replace(/\r?\n$/, ''), prose }
}

// Verbos que justifican que el fichero nuevo sea mucho más corto que el actual.
const SHRINK_INTENT_RE =
  /\b(quita|elimina|borra|suprime|remove|delete|strip|simplifica|simplify|acorta|shorten|reduce|limpia|clean)\b/i

/**
 * Un modelo pequeño a menudo devuelve solo la parte que cambió. Aplicarla
 * borraría el resto del fichero: si el resultado pierde más de la mitad de las
 * líneas sin que se haya pedido borrar, lo tratamos como parcial.
 */
export function looksLikePartialEdit(oldCode: string, newCode: string, userMessage: string): boolean {
  const oldLines = oldCode.split('\n').filter((line) => line.trim()).length
  const newLines = newCode.split('\n').filter((line) => line.trim()).length
  if (oldLines < 6) return false
  return newLines < oldLines * 0.5 && !SHRINK_INTENT_RE.test(userMessage)
}

// Peticiones que solo añaden: nada de lo que ya hay debería desaparecer.
const ADDITIVE_INTENT_RE =
  /\b(a[ñn]ad(?:e|ir)|agrega(?:r)?|add|inserta(?:r)?|insert|tambi[eé]n|also|adem[aá]s|as\s+well|incluye|include)\b/i

function normalizeCodeLine(line: string): string {
  return line.trim().replace(/;$/, '').replace(/\s+/g, ' ').replace(/"/g, "'")
}

// Palabras que aparecen en casi cualquier línea y no dicen qué hace: si contasen,
// `console.log(total)` y `console.log(max)` parecerían la misma línea.
const COMMON_TOKENS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'of', 'in', 'while', 'new', 'this',
  'true', 'false', 'null', 'undefined', 'await', 'async', 'console', 'log', 'info', 'warn', 'error', 'Math',
])

function lineTokens(line: string): Set<string> {
  return new Set((line.match(/[A-Za-z_$][\w$]*|\d+/g) ?? []).filter((token) => !COMMON_TOKENS.has(token)))
}

// Dos líneas "son la misma" modificada si comparten la mayoría de identificadores
// (`console.log(total)` → `console.log("Total:", total)`).
function areSimilarLines(a: string, b: string): boolean {
  const left = lineTokens(a)
  const right = lineTokens(b)
  if (left.size === 0 || right.size === 0) return false
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / Math.min(left.size, right.size) >= 0.6
}

function isDroppedLine(line: string, keptLines: Set<string>, newLines: string[]): boolean {
  const normalized = normalizeCodeLine(line)
  if (!normalized || normalized.startsWith('//') || keptLines.has(normalized)) return false
  return !newLines.some((newLine) => areSimilarLines(line, newLine))
}

/**
 * Líneas del código actual que han desaparecido en la propuesta (ni están ni hay
 * una versión modificada). En una petición aditiva ("añade…", "imprime también…")
 * un modelo pequeño suele reescribir y perder líneas que no debía tocar.
 */
export function findDroppedLines(oldCode: string, newCode: string, userMessage: string): string[] {
  if (!ADDITIVE_INTENT_RE.test(userMessage) || SHRINK_INTENT_RE.test(userMessage)) return []
  const newLines = newCode.split('\n')
  const kept = new Set(newLines.map(normalizeCodeLine))
  return oldCode
    .split('\n')
    .filter((line) => isDroppedLine(line, kept, newLines))
    .map((line) => line.trim())
}

/**
 * Arreglo determinista para una edición aditiva que perdió líneas: conserva las
 * líneas nuevas del modelo en su sitio y restaura las borradas en el suyo (salvo
 * las que el modelo solo modificó). Más fiable que pedirle otro intento.
 */
export function mergeAdditiveEdit(oldCode: string, newCode: string): string {
  const newLines = newCode.split('\n')
  const kept = new Set(newLines.map(normalizeCodeLine))
  return computeLineDiff(oldCode, newCode)
    .lines.filter((line) => line.type !== 'del' || isDroppedLine(line.text, kept, newLines))
    .map((line) => line.text)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Prompts: una sola tarea por llamada, sin protocolo que seguir.
// ---------------------------------------------------------------------------

function buildAnswerSystemPrompt(replyLanguage: string): string {
  return `You are GoJS Assistant, a friendly coding assistant inside a JavaScript and TypeScript playground.
Reply to the user's last message directly, in Markdown.
Reply in ${replyLanguage}.
Be concise and specific. When the user asks about the code, refer to the actual code shown.
If the user just greets you, greet back briefly and offer help with their code.
Never output tags, labels or words like "final" or "run" on their own.`
}

function buildEditSystemPrompt(language: string, replyLanguage: string): string {
  return `You edit code in a ${language} playground.
Apply the requested change to the user's code exactly as asked, keeping everything else the same.
Reply with the COMPLETE updated file inside ONE \`\`\`${language} code block. Never return only the changed part.
After the code block, write one short sentence in ${replyLanguage} that describes the change.
Output nothing else.`
}


function codeBlock(code: string, language: string): string {
  return code.trim() ? `\`\`\`${language}\n${code}\n\`\`\`` : '(the editor is empty)'
}

function historyMessages(history: AgentExchange[] | undefined): ChatMessage[] {
  // Muy poco historial y recortado: a un modelo pequeño un historial largo le pesa
  // más que la petición nueva (tiende a repetir su respuesta anterior).
  return (history ?? []).slice(-2).flatMap((exchange) => [
    { role: 'user' as const, content: exchange.user },
    {
      role: 'assistant' as const,
      content: exchange.assistant.length > 400 ? `${exchange.assistant.slice(0, 400)}…` : exchange.assistant,
    },
  ])
}

function buildAnswerMessages(input: {
  message: string
  code: string
  language: string
  context?: string
  runReport?: string
  history?: AgentExchange[]
}): ChatMessage[] {
  const parts = isSmallTalk(input.message) ? [] : [`The user's current code:\n${codeBlock(input.code, input.language)}`]
  if (input.context) parts.push(input.context)
  if (input.runReport) parts.push(input.runReport)
  parts.push(`User message: ${input.message}`)
  return [
    { role: 'system', content: buildAnswerSystemPrompt(detectUserLanguage(input.message)) },
    ...historyMessages(input.history),
    { role: 'user', content: parts.join('\n\n') },
  ]
}

function buildEditMessages(input: {
  message: string
  code: string
  language: string
  context?: string
  feedback?: string
}): ChatMessage[] {
  const parts = [`Current code:\n${codeBlock(input.code, input.language)}`]
  if (input.context) parts.push(input.context)
  parts.push(`Requested change: ${input.message}`)
  if (input.feedback) parts.push(input.feedback)
  return [
    { role: 'system', content: buildEditSystemPrompt(input.language, detectUserLanguage(input.message)) },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

function summarizeOutput(result: AgentRunResult): string {
  if (result.hasError) return 'execution error'
  const lines = result.output.split('\n').filter((l) => l.trim()).length
  return lines > 0 ? `${lines} line${lines === 1 ? '' : 's'} of output` : 'no errors'
}

function truncateOutput(output: string, max = 800): string {
  const trimmed = output.trim() || '(no console output)'
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n…(truncated)` : trimmed
}

function firstSentence(text: string): string | undefined {
  const sentence = text.split('\n').find((line) => line.trim())?.trim()
  return sentence && sentence.length <= 140 ? sentence : undefined
}

const NO_ANSWER_MESSAGE =
  "The model couldn't produce an answer for that. Try rephrasing it, or pick a larger model in the selector below."

// ---------------------------------------------------------------------------
// Loop principal
// ---------------------------------------------------------------------------

export async function runAgent(userMessage: string, deps: AgentDeps): Promise<void> {
  const { generate, bridge, ui } = deps
  const language = bridge.language?.() ?? 'javascript'

  const callModel = async (messages: ChatMessage[], options?: AgentGenerationOptions): Promise<string | null> => {
    try {
      return await generate(messages, undefined, options)
    } catch (error) {
      ui.clearStatus()
      ui.finalAnswer(`⚠️ ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  const previousAnswer = deps.history?.at(-1)?.assistant
  const tidy = (raw: string) => removeEchoes(cleanModelText(raw))
  const isUsable = (text: string) => isMeaningfulAnswer(text) && !isRepeatOf(text, previousAnswer)

  // Pide una respuesta en Markdown. Si el modelo devuelve basura (vacío, "final",
  // o repite su respuesta anterior), reintenta una vez SIN historial y, si
  // tampoco, devuelve null para que el llamante lo diga en vez de mostrarla.
  const ask = async (runReport?: string): Promise<string | null | undefined> => {
    ui.status('Thinking…')
    const input = { message: userMessage, code: bridge.getCode(), language, context: deps.context, runReport }
    const first = await callModel(buildAnswerMessages({ ...input, history: runReport ? undefined : deps.history }))
    if (first === null) return undefined
    let text = tidy(first)
    if (!isUsable(text)) {
      const retry = await callModel(buildAnswerMessages(input))
      if (retry === null) return undefined
      text = tidy(retry)
    }
    return isUsable(text) ? text : null
  }

  const answer = async (): Promise<void> => {
    const text = await ask()
    if (text === undefined) return
    ui.clearStatus()
    ui.finalAnswer(text ?? NO_ANSWER_MESSAGE)
  }

  const runCode = async (): Promise<AgentRunResult> => {
    ui.status('Running the code…')
    const handle = ui.run()
    let result: AgentRunResult
    try {
      result = await bridge.run()
    } catch (error) {
      result = { output: error instanceof Error ? error.message : String(error), hasError: true }
    }
    handle.update(summarizeOutput(result), result.hasError ? 'error' : 'ok')
    return result
  }

  // Aplica una edición al editor y pinta su diff. Devuelve false si no cambia nada.
  const applyEdit = (newCode: string, note?: string): boolean => {
    const oldCode = bridge.getCode()
    const diff = computeLineDiff(oldCode, newCode)
    if (diff.added === 0 && diff.removed === 0) return false
    ui.status('Editing the code…')
    bridge.setCode(newCode)
    ui.edit({ added: diff.added, removed: diff.removed, note, lines: diff.lines })
    return true
  }

  // Fast-path determinista: para transformaciones mecánicas puras NO dependemos
  // del modelo: las hace el propio harness.
  const deterministic = detectDeterministicIntent(userMessage)
  if (deterministic === 'strip-comments') {
    const oldCode = bridge.getCode()
    const newCode = stripComments(oldCode)
    const { removed } = computeLineDiff(oldCode, newCode)
    const changed = applyEdit(newCode, 'Removed comments')
    ui.clearStatus()
    ui.finalAnswer(
      changed ? `Removed all comments (−${removed} ${removed === 1 ? 'line' : 'lines'}).` : 'The code has no comments to remove.',
    )
    return
  }
  if (deterministic === 'format' && bridge.format) {
    const oldCode = bridge.getCode()
    ui.status('Formatting the code…')
    let newCode = oldCode
    try {
      newCode = await bridge.format(oldCode)
    } catch {
      newCode = oldCode
    }
    const diff = computeLineDiff(oldCode, newCode)
    const changed = applyEdit(newCode, 'Formatted with Prettier')
    ui.clearStatus()
    ui.finalAnswer(changed ? `Formatted the code (+${diff.added} −${diff.removed}).` : 'The code is already properly formatted.')
    return
  }

  const mode = detectAgentMode(userMessage)

  if (mode === 'answer') {
    await answer()
    return
  }

  if (mode === 'run') {
    // La salida real la pone el harness: un modelo pequeño la inventa o la ignora.
    // El modelo solo añade, si puede, una explicación breve.
    const result = await runCode()
    // Sin las anotaciones de línea (" (L3)"): el modelo las copiaba en su respuesta.
    const output = truncateOutput(result.output).replace(/ \(L\d+\)$/gm, '')
    const report = `\`\`\`console\n${output}\n\`\`\``
    const explanation = await ask(
      `The code was just executed. Console output:\n\`\`\`\n${output}\n\`\`\`${
        result.hasError ? '\nThe execution threw an uncaught error.' : ''
      }\nExplain the result briefly.`,
    )
    if (explanation === undefined) return
    ui.clearStatus()
    ui.finalAnswer(explanation ? `${report}\n\n${explanation}` : report)
    return
  }

  // Edición: el modelo solo devuelve el fichero completo; el harness lo valida,
  // lo aplica, lo ejecuta y, si falla, le pasa el error para que lo arregle.
  const maxAttempts = Math.max(1, Math.min(deps.maxSteps ?? 4, 4))
  let feedback: string | undefined
  let lastError: string | null = null
  let editsApplied = 0
  let lastProse = ''

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    ui.status(attempt === 0 ? 'Planning the change…' : 'Fixing the code…')
    const raw = await callModel(
      buildEditMessages({ message: userMessage, code: bridge.getCode(), language, context: deps.context, feedback }),
      { temperature: 0 },
    )
    if (raw === null) return

    const { code: newCode, prose } = extractEditedCode(raw)

    if (!newCode?.trim()) {
      feedback = `Your previous reply had no code block. Reply with the complete updated file inside one \`\`\`${language} code block.`
      continue
    }

    if (looksLikePartialEdit(bridge.getCode(), newCode, userMessage)) {
      feedback =
        'Your previous reply contained only part of the file. Return the COMPLETE file with the change applied, keeping every other line.'
      continue
    }

    // Petición aditiva que perdió líneas: las restauramos nosotros.
    let proposal = newCode
    if (findDroppedLines(bridge.getCode(), newCode, userMessage).length > 0) {
      proposal = mergeAdditiveEdit(bridge.getCode(), newCode)
    }

    const explanation = cleanEditProse(prose)
    if (!applyEdit(proposal, firstSentence(explanation))) {
      feedback = 'Your previous reply returned the code unchanged. Apply the requested change this time.'
      continue
    }
    editsApplied++
    if (explanation) lastProse = explanation

    const result = await runCode()
    if (!result.hasError) {
      lastError = null
      break
    }

    const output = truncateOutput(result.output)
    if (output === lastError) break // el mismo error otra vez: no insistimos
    lastError = output
    feedback = `After your change the code throws this error when it runs:\n\`\`\`\n${output}\n\`\`\`\nFix it and return the complete file again.`
  }

  ui.clearStatus()
  if (editsApplied === 0) {
    ui.finalAnswer(
      "I couldn't apply that change — the model didn't return a usable version of the code. Try describing it differently, or pick a larger model.",
    )
    return
  }
  if (lastError !== null) {
    ui.finalAnswer(
      `I changed the code, but it still throws an error:\n\n\`\`\`\n${lastError.slice(0, 500)}\n\`\`\`\n\nTell me more about what you expect and I'll try again.`,
    )
    return
  }
  ui.finalAnswer(lastProse || 'Updated the code. It runs without errors.')
}
