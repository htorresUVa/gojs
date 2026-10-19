import { describe, expect, it } from 'vitest'
import {
  cleanEditProse,
  cleanModelText,
  detectAgentMode,
  detectUserLanguage,
  findDroppedLines,
  detectDeterministicIntent,
  extractEditedCode,
  isEditIntent,
  isMeaningfulAnswer,
  isRepeatOf,
  isSmallTalk,
  looksLikePartialEdit,
  removeEchoes,
  runAgent,
  stripComments,
  type AgentBridge,
  type AgentRunResult,
  type AgentUI,
} from './agent'
import type { ChatMessage } from '../chatbot'

// Bridge y UI de mentira para probar el harness de forma determinista. `runErrors`
// indica, ejecución a ejecución, si el código falla (por defecto, nunca).
function makeHarness(initialCode = '', runErrors: boolean[] = []) {
  const state = { code: initialCode, runs: 0 }
  const events: string[] = []

  const bridge: AgentBridge = {
    getCode: () => state.code,
    setCode: (code) => {
      state.code = code
      events.push('setCode')
    },
    run: async (): Promise<AgentRunResult> => {
      const hasError = runErrors[state.runs] ?? false
      state.runs += 1
      events.push(hasError ? 'run:error' : 'run:ok')
      return { output: hasError ? 'ERROR: x is not defined (L1)' : '5 (L2)', hasError }
    },
    language: () => 'javascript',
  }

  bridge.format = async (code: string) => code.replace(/;+/g, ';').replace(/\s+$/gm, '')

  const finals: string[] = []
  const ui: AgentUI = {
    edit: (info) => events.push(`edit:+${info.added}-${info.removed}`),
    run: () => {
      events.push('step:run')
      return { update: (_detail, s) => events.push(`update:${s ?? ''}`) }
    },
    finalAnswer: (md) => {
      finals.push(md)
      events.push('final')
    },
    status: () => {},
    clearStatus: () => {},
  }

  return { state, events, finals, bridge, ui }
}

// Modelo guionizado: devuelve las respuestas en orden y guarda los mensajes recibidos.
function scriptedModel(replies: string[]) {
  const calls: ChatMessage[][] = []
  const generate = async (messages: ChatMessage[]) => {
    calls.push(messages)
    return replies[Math.min(calls.length - 1, replies.length - 1)]
  }
  return { generate, calls }
}

const LONG_FILE = Array.from({ length: 10 }, (_, i) => `const v${i} = ${i}`).join('\n')

describe('detectAgentMode', () => {
  it('answers greetings and questions, even when they mention editing', () => {
    for (const m of [
      'Hola',
      '¿De qué va el código?',
      'explain this loop',
      'why does it print 1?',
      '¿Cómo puedo añadir un bucle?',
      'what does map do here?',
    ]) {
      expect(detectAgentMode(m), m).toBe('answer')
    }
  })

  it('edits on imperative or polite change requests', () => {
    for (const m of [
      'arregla el error',
      'fix the bug',
      'haz que imprima hola',
      'añade una función suma',
      '¿Puedes añadir un bucle?',
      'can you rename x to total?',
      'write a fizzbuzz',
    ]) {
      expect(detectAgentMode(m), m).toBe('edit')
    }
  })

  it('runs the code when asked to execute it or what it prints', () => {
    for (const m of ['ejecútalo', 'run it', '¿Qué imprime?', 'what does it print?']) {
      expect(detectAgentMode(m), m).toBe('run')
    }
  })
})

describe('detectUserLanguage', () => {
  it('names the language explicitly for the prompt', () => {
    expect(detectUserLanguage('haz que imprima la media')).toBe('Spanish')
    expect(detectUserLanguage('¿Qué imprime?')).toBe('Spanish')
    expect(detectUserLanguage('make it print the average')).toBe('English')
  })
})

describe('cleanEditProse', () => {
  it('drops labels copied from the instructions and keeps one sentence', () => {
    const prose = 'Change: Added the average.\nSentence: We added the average of the numbers.'
    expect(cleanEditProse(prose)).toBe('Added the average.')
  })
})

describe('isSmallTalk', () => {
  it('recognises greetings and thanks, not real questions', () => {
    for (const m of ['Hola', '¡Hola!', 'hola gojs', 'Buenos días', 'thanks!', 'Gracias 🙏']) expect(isSmallTalk(m), m).toBe(true)
    for (const m of ['Hola, ¿qué hace este código?', '¿De qué va el código?', 'thanks, now fix the bug']) {
      expect(isSmallTalk(m), m).toBe(false)
    }
  })

  it('does not send the code to the model for a greeting', async () => {
    const { bridge, ui } = makeHarness('const secret = 42')
    const { generate, calls } = scriptedModel(['¡Hola! ¿En qué te ayudo?'])

    await runAgent('Hola', { generate, bridge, ui })

    expect(calls[0].at(-1)?.content).not.toContain('const secret')
  })
})

describe('cleanModelText', () => {
  it('drops bare protocol words that small models emit instead of answering', () => {
    expect(cleanModelText('final')).toBe('')
    expect(cleanModelText('run')).toBe('')
    expect(cleanModelText('<think>hmm</think>run')).toBe('')
  })

  it('cuts an invented next user turn (seen with a 0.5B model)', () => {
    const raw = 'Ejemplo con map:\n```js\nnumbers.map((n) => n * 2)\n```\nUser message: ¿Y con strings?'
    expect(cleanModelText(raw)).toBe('Ejemplo con map:\n```js\nnumbers.map((n) => n * 2)\n```')
  })

  it('keeps the real answer around leaked tags and role prefixes', () => {
    expect(cleanModelText('<action>final</action>\n¡Hola! ¿En qué te ayudo?')).toBe('¡Hola! ¿En qué te ayudo?')
    expect(cleanModelText('Assistant: It logs 4.')).toBe('It logs 4.')
    expect(cleanModelText('<think>unfinished reasoning')).toBe('')
  })

  it('isMeaningfulAnswer rejects empty or punctuation-only replies', () => {
    expect(isMeaningfulAnswer('')).toBe(false)
    expect(isMeaningfulAnswer('```\n```')).toBe(false)
    expect(isMeaningfulAnswer('Sí')).toBe(true)
  })
})

describe('removeEchoes', () => {
  it('cuts the repeated answer after a meta phrase (seen with a 0.5B model)', () => {
    const raw =
      'La función reduce suma los elementos.\n\nPor lo tanto, la respuesta al usuario sería:\n\nLa función reduce suma los elementos.'
    expect(removeEchoes(raw)).toBe('La función reduce suma los elementos.')
  })

  it('drops duplicated paragraphs and keeps distinct ones', () => {
    expect(removeEchoes('A uno.\n\nB dos.\n\nA uno.')).toBe('A uno.\n\nB dos.')
  })
})

describe('isRepeatOf', () => {
  const previous = 'La función reduce se utiliza para acumular los elementos de un array en una sola variable total.'

  it('detects a near-copy of the previous answer', () => {
    expect(isRepeatOf(`${previous} Así funciona.`, previous)).toBe(true)
  })

  it('accepts a different answer', () => {
    expect(isRepeatOf('Imprime 6 porque suma uno más dos más tres usando reduce sobre numbers.', previous)).toBe(false)
  })
})

describe('extractEditedCode', () => {
  it('takes the longest code block (the full file) and keeps the prose apart', () => {
    const raw = 'Change this:\n```js\nx++\n```\nFull file:\n```js\nlet x = 1\nx++\nconsole.log(x)\n```\nIncrements x.'
    const { code, prose } = extractEditedCode(raw)
    expect(code).toBe('let x = 1\nx++\nconsole.log(x)')
    expect(prose).toContain('Increments x.')
  })

  it('returns null code when there is no fenced block', () => {
    expect(extractEditedCode('I would change the loop').code).toBeNull()
  })
})

describe('findDroppedLines', () => {
  const code = 'const numbers = [1, 2, 3]\nconst total = numbers.reduce((a, b) => a + b, 0)\nconsole.log(total)'

  it('lists existing lines lost in an additive request (seen with 0.5B and 0.8B models)', () => {
    const proposal = 'const numbers = [1, 2, 3]\nconst max = Math.max(...numbers)\nconsole.log(max)'
    expect(findDroppedLines(code, proposal, 'añade una función que devuelva el máximo')).toEqual([
      'const total = numbers.reduce((a, b) => a + b, 0)',
      'console.log(total)',
    ])
  })

  it('does not count a line the model only modified as deleted', () => {
    const proposal = 'const numbers = [1, 2, 3]\nconst total = numbers.reduce((a, b) => a + b, 0)\nconsole.log("Total:", total)\nconsole.log(total / 3)'
    expect(findDroppedLines(code, proposal, 'imprime también la media')).toEqual([])
  })

  it('ignores formatting-only differences and non-additive requests', () => {
    const reformatted = 'const numbers = [1, 2, 3];\nconst total = numbers.reduce((a, b) => a + b, 0);\nconsole.log(total);\nconsole.log(total / 3);'
    expect(findDroppedLines(code, reformatted, 'imprime también la media')).toEqual([])
    expect(findDroppedLines(code, 'console.log(6)', 'simplifica el código')).toEqual([])
  })
})

describe('looksLikePartialEdit', () => {
  it('flags a reply that drops most of the file without being asked to', () => {
    expect(looksLikePartialEdit(LONG_FILE, 'const v0 = 42', 'change v0 to 42')).toBe(true)
  })

  it('accepts big deletions when the user asked to remove code', () => {
    expect(looksLikePartialEdit(LONG_FILE, 'const v0 = 0', 'elimina todo menos v0')).toBe(false)
  })
})

describe('runAgent: answers', () => {
  it('never shows a bare "final" — retries and then says the model failed', async () => {
    const { events, finals, bridge, ui } = makeHarness('console.log(1)')
    const { generate, calls } = scriptedModel(['final', 'final'])

    await runAgent('Hola', { generate, bridge, ui })

    expect(calls).toHaveLength(2)
    expect(finals).toHaveLength(1)
    expect(finals[0]).not.toMatch(/^final$/i)
    expect(finals[0]).toMatch(/couldn't produce an answer/i)
    expect(events).not.toContain('setCode')
  })

  it('recovers when the first reply is a protocol word and the retry is a real answer', async () => {
    const { finals, bridge, ui } = makeHarness('console.log(1)')
    const { generate } = scriptedModel(['run', 'Imprime 1 por consola.'])

    await runAgent('¿De qué va el código?', { generate, bridge, ui })

    expect(finals).toEqual(['Imprime 1 por consola.'])
  })

  it('answers questions without touching the code and sends the code as context', async () => {
    const { events, finals, bridge, ui } = makeHarness('console.log(1)')
    const { generate, calls } = scriptedModel(['It prints 1 because you log the literal 1.'])

    await runAgent('why does it print 1?', { generate, bridge, ui })

    expect(events).not.toContain('setCode')
    expect(finals[0]).toContain('prints 1')
    expect(calls[0].at(-1)?.content).toContain('console.log(1)')
  })

  it('does not treat words inside the selection context as an edit request', async () => {
    const { events, bridge, ui } = makeHarness('const a = 1')
    const { generate } = scriptedModel(['It declares a constant.'])

    await runAgent('¿qué hace esto?', {
      generate,
      bridge,
      ui,
      context: 'The user selected this code:\n```\n// remove this later\nconst a = 1\n```',
    })

    expect(events).not.toContain('setCode')
  })

  it('includes recent conversation history before the new message', async () => {
    const { bridge, ui } = makeHarness('const a = 1')
    const { generate, calls } = scriptedModel(['Es la línea que declara a.'])

    await runAgent('¿y la línea 1?', {
      generate,
      bridge,
      ui,
      history: [{ user: 'Hola', assistant: '¡Hola! ¿En qué te ayudo?' }],
    })

    const roles = calls[0].map((message) => message.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'user'])
  })

  it('runs the code first when asked what it prints and shows the real output itself', async () => {
    const { events, finals, bridge, ui } = makeHarness('console.log(5)')
    const { generate, calls } = scriptedModel(['Imprime 5.'])

    await runAgent('¿Qué imprime?', { generate, bridge, ui })

    expect(events).toContain('step:run')
    expect(calls[0].at(-1)?.content).toContain('Console output:\n```\n5\n```')
    expect(calls[0].at(-1)?.content).not.toContain('(L2)')
    expect(finals[0]).toContain('```console\n5\n```')
    expect(finals[0]).toContain('Imprime 5.')
  })

  it('still shows the output when the model cannot explain it', async () => {
    const { finals, bridge, ui } = makeHarness('console.log(5)')
    const { generate } = scriptedModel(['final'])

    await runAgent('run it', { generate, bridge, ui })

    expect(finals[0]).toContain('```console\n5\n```')
    expect(finals[0]).not.toMatch(/final/)
  })

  it('retries without history when the model repeats its previous answer', async () => {
    const previous = 'La función reduce se utiliza para acumular los elementos de un array en una sola variable total.'
    const { finals, bridge, ui } = makeHarness('const a = 1')
    const { generate, calls } = scriptedModel([previous, 'Declara la constante a con el valor uno para usarla luego en el programa.'])

    await runAgent('¿y la línea 1?', { generate, bridge, ui, history: [{ user: '¿De qué va?', assistant: previous }] })

    expect(calls).toHaveLength(2)
    expect(calls[1].map((message) => message.role)).toEqual(['system', 'user'])
    expect(finals[0]).toContain('Declara la constante')
  })
})

describe('runAgent: edits', () => {
  it('applies the full file, runs it and finishes with the model explanation', async () => {
    const { state, events, finals, bridge, ui } = makeHarness('console.log(1)')
    const { generate } = scriptedModel(['```js\nconsole.log("hola")\n```\nAhora imprime hola.'])

    await runAgent('haz que imprima hola', { generate, bridge, ui })

    expect(state.code).toBe('console.log("hola")')
    expect(events).toEqual(['setCode', 'edit:+1-1', 'step:run', 'run:ok', 'update:ok', 'final'])
    expect(finals[0]).toBe('Ahora imprime hola.')
  })

  it('asks for the edit deterministically and in the user language', async () => {
    const { bridge, ui } = makeHarness('console.log(1)')
    const options: unknown[] = []
    const calls: ChatMessage[][] = []
    const generate = async (messages: ChatMessage[], _onChunk?: unknown, opts?: unknown) => {
      calls.push(messages)
      options.push(opts)
      return '```js\nconsole.log(2)\n```\nCambia el número.'
    }

    await runAgent('cambia el 1 por un 2', { generate, bridge, ui })

    expect(options[0]).toEqual({ temperature: 0 })
    expect(calls[0][0].content).toContain('in Spanish')
    expect(calls[0].map((message) => message.role)).toEqual(['system', 'user'])
  })

  it('feeds the runtime error back and applies the fix', async () => {
    const { state, events, bridge, ui } = makeHarness('cosnt x = 5\nconsole.log(x)', [true, false])
    const { generate, calls } = scriptedModel([
      '```js\nconst x = 5\nconsole.log(y)\n```',
      '```js\nconst x = 5\nconsole.log(x)\n```\nFixed the typo.',
    ])

    await runAgent('arregla el error', { generate, bridge, ui })

    expect(events.filter((e) => e === 'setCode')).toHaveLength(2)
    expect(events).toContain('run:error')
    expect(events.at(-2)).toBe('update:ok')
    expect(calls[1].at(-1)?.content).toContain('ERROR: x is not defined')
    expect(state.code).toBe('const x = 5\nconsole.log(x)')
  })

  it('asks again when the reply has no code block', async () => {
    const { state, bridge, ui } = makeHarness('const x = 1')
    const { generate, calls } = scriptedModel(['final', '```js\nconst x = 2\n```'])

    await runAgent('cambia x a 2', { generate, bridge, ui })

    expect(state.code).toBe('const x = 2')
    expect(calls[1].at(-1)?.content).toMatch(/no code block/i)
  })

  it('rejects a partial file instead of deleting the rest of the code', async () => {
    const { state, bridge, ui } = makeHarness(LONG_FILE)
    const complete = LONG_FILE.replace('const v0 = 0', 'const v0 = 42')
    const { generate, calls } = scriptedModel(['```js\nconst v0 = 42\n```', `\`\`\`js\n${complete}\n\`\`\``])

    await runAgent('change v0 to 42', { generate, bridge, ui })

    expect(state.code).toBe(complete)
    expect(calls[1].at(-1)?.content).toMatch(/only part of the file/i)
  })

  it('restores lines an additive edit deleted, without asking the model again', async () => {
    const { state, bridge, ui } = makeHarness('const a = 1\nconsole.log(a)')
    const { generate, calls } = scriptedModel(['```js\nconst b = 2\nconsole.log(b)\n```'])

    await runAgent('añade una variable b y imprímela también', { generate, bridge, ui })

    expect(calls).toHaveLength(1)
    expect(state.code).toBe('const a = 1\nconsole.log(a)\nconst b = 2\nconsole.log(b)')
  })

  it('says so honestly when the model never returns usable code', async () => {
    const { events, finals, bridge, ui } = makeHarness('const x = 1')
    const { generate, calls } = scriptedModel(['Done, it already works.'])

    await runAgent('arregla el bug del codigo', { generate, bridge, ui, maxSteps: 3 })

    expect(calls).toHaveLength(3)
    expect(events).not.toContain('setCode')
    expect(finals.at(-1)).toMatch(/couldn't apply that change/i)
  })

  it('stops when the same error repeats and reports it', async () => {
    const { finals, bridge, ui } = makeHarness('const x = 1', [true, true, true])
    const { generate } = scriptedModel(['```js\nconst x = 2\nboom()\n```', '```js\nconst x = 3\nboom()\n```'])

    await runAgent('arregla el error', { generate, bridge, ui })

    expect(finals.at(-1)).toMatch(/still throws an error/i)
  })
})

describe('runAgent: deterministic fast paths', () => {
  it('"quita los comentarios" strips them without ever calling the model', async () => {
    const { state, events, bridge, ui } = makeHarness("// top\nconst u = 'http://x' // trailing\nconst y = 2")
    const { generate, calls } = scriptedModel(['nope'])

    await runAgent('quita los comentarios del codigo', { generate, bridge, ui })

    expect(calls).toHaveLength(0)
    expect(events).toContain('setCode')
    expect(state.code).not.toMatch(/\/\/ top|\/\/ trailing/)
    expect(state.code).toContain("'http://x'")
  })

  it('reports honestly when there are no comments to remove', async () => {
    const { events, finals, bridge, ui } = makeHarness('const x = 1')
    const { generate } = scriptedModel(['nope'])

    await runAgent('quita los comentarios', { generate, bridge, ui })

    expect(events).not.toContain('setCode')
    expect(finals.at(-1)).toMatch(/no comments to remove/i)
  })

  it('formats with the harness formatter', async () => {
    const { state, events, bridge, ui } = makeHarness('const x = 1;;;   ')
    const { generate, calls } = scriptedModel(['nope'])

    await runAgent('formatea el codigo', { generate, bridge, ui })

    expect(calls).toHaveLength(0)
    expect(events).toContain('setCode')
    expect(state.code).toBe('const x = 1;')
  })

  it('falls through to the model when the request mixes other work', async () => {
    const { state, bridge, ui } = makeHarness('// c\nconst x = 1')
    const { generate } = scriptedModel(['```js\nconst x = 1\nfunction f() {}\n```'])

    await runAgent('quita los comentarios y añade una función', { generate, bridge, ui })

    expect(state.code).toContain('function f()')
  })
})

describe('stripComments', () => {
  it('removes line and block comments but keeps code', () => {
    const src = "// Bienvenido a XJS!\nconsole.log('hi'); // inline\n/* block\n comment */\nconst x = 2"
    const out = stripComments(src)
    expect(out).not.toMatch(/Bienvenido|inline|block|comment/)
    expect(out).toContain("console.log('hi');")
    expect(out).toContain('const x = 2')
  })

  it('does not touch // or /* */ inside strings, templates or regex', () => {
    const src = "const u = 'http://x'\nconst t = `a // b`\nconst r = /a\\/b/\nconst d = \"/* not a comment */\""
    const out = stripComments(src)
    expect(out).toContain("'http://x'")
    expect(out).toContain('`a // b`')
    expect(out).toContain('/a\\/b/')
    expect(out).toContain('"/* not a comment */"')
  })

  it('returns identical code when there are no comments', () => {
    const src = "console.log('no comments here')\nconst x = 1"
    expect(stripComments(src)).toBe(src)
  })
})

describe('isEditIntent', () => {
  it('detects imperative edit requests (ES + EN)', () => {
    for (const m of ['quita los comentarios', 'elimina esto', 'arregla el error', 'fix the bug', 'format the code', 'refactoriza']) {
      expect(isEditIntent(m)).toBe(true)
    }
  })

  it('does not flag plain questions', () => {
    for (const m of ['why does it print 1?', '¿qué hace este código?', 'explain this loop']) {
      expect(isEditIntent(m)).toBe(false)
    }
  })
})

describe('detectDeterministicIntent', () => {
  it('detects pure comment-removal requests', () => {
    for (const m of ['quita los comentarios', 'elimina los comentarios del codigo', 'remove all comments', 'código sin comentarios']) {
      expect(detectDeterministicIntent(m)).toBe('strip-comments')
    }
  })

  it('detects pure format requests', () => {
    for (const m of ['formatea el codigo', 'format this', 'prettify the file']) {
      expect(detectDeterministicIntent(m)).toBe('format')
    }
  })

  it('returns null when the request mixes extra work or is a question', () => {
    expect(detectDeterministicIntent('quita los comentarios y añade tipos')).toBeNull()
    expect(detectDeterministicIntent('refactoriza y formatea')).toBeNull()
    expect(detectDeterministicIntent('¿por qué hay tantos comentarios?')).toBeNull()
    expect(detectDeterministicIntent('arregla el bug')).toBeNull()
  })
})
