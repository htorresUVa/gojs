import { describe, expect, it } from 'vitest'
import { isWorkerLoadFailure, WorkerLoadError } from './code-prep'

describe('isWorkerLoadFailure', () => {
  it('trata un evento de error sin mensaje como fallo de carga (asset viejo, MIME incorrecto)', () => {
    expect(isWorkerLoadFailure(new Event('error'))).toBe(true)
    expect(isWorkerLoadFailure(new ErrorEvent('error'))).toBe(true)
  })

  it('distingue una excepción no capturada dentro de un worker que sí arrancó', () => {
    expect(isWorkerLoadFailure(new ErrorEvent('error', { message: 'Uncaught Error: boom' }))).toBe(false)
  })
})

describe('WorkerLoadError', () => {
  it('se puede distinguir de un error de sintaxis del código', () => {
    const error = new WorkerLoadError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('WorkerLoadError')
  })
})
