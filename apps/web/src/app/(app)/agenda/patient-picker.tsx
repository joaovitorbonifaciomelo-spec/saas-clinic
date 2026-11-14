'use client'

import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import type { Patient } from '@clinicas/shared'
import { quickCreatePatientAction } from '../patients/patient-actions'
import { formatPhone } from '../../ui/format'

export type PatientOption = Pick<Patient, 'id' | 'name' | 'phone'>

const MAX_RESULTADOS = 8

/** Sem acento e sem caixa: "jose" encontra "José". */
export function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

const digitos = (texto: string) => texto.replace(/\D/g, '')

/**
 * Busca por nome (todas as palavras digitadas, em qualquer ordem) ou por telefone.
 * Quem comeca com o termo vem primeiro.
 */
export function filtrarPacientes(
  pacientes: readonly PatientOption[],
  termo: string,
  max = MAX_RESULTADOS,
): PatientOption[] {
  const q = normalizar(termo)
  if (q === '') return pacientes.slice(0, max)
  const palavras = q.split(/\s+/)
  const numero = digitos(termo)
  const achados = pacientes.filter((p) => {
    const nome = normalizar(p.name)
    if (palavras.every((w) => nome.includes(w))) return true
    return numero.length >= 3 && digitos(p.phone).includes(numero)
  })
  const comeca = (p: PatientOption) => (normalizar(p.name).startsWith(q) ? 0 : 1)
  return achados.sort((a, b) => comeca(a) - comeca(b)).slice(0, max)
}

/** Texto que parece telefone vai para o campo de telefone do cadastro rapido. */
function pareceTelefone(texto: string): boolean {
  return /^[\d\s()+-]+$/.test(texto) && digitos(texto).length >= 8
}

interface PatientPickerProps {
  inputId: string
  patients: readonly PatientOption[]
  value: string
  /** Nome do paciente atual quando ele nao esta na lista carregada. */
  valueLabel?: string
  onChange: (patientId: string) => void
  onCreated: (patient: PatientOption) => void
}

/**
 * Campo de paciente da agenda: digita, escolhe, ou cadastra ali mesmo sem sair
 * do agendamento. O cadastro e um bloco dentro do formulario do agendamento, e
 * nao um <form> proprio: formulario dentro de formulario e HTML invalido, e o
 * Enter enviaria o agendamento.
 */
export function PatientPicker(props: PatientPickerProps) {
  const listId = useId()
  const atual = props.patients.find((p) => p.id === props.value)
  const [texto, setTexto] = useState(atual?.name ?? props.valueLabel ?? '')
  const [aberto, setAberto] = useState(false)
  const [ativo, setAtivo] = useState(0)
  const [cadastro, setCadastro] = useState<{ name: string; phone: string } | null>(null)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const resultados = useMemo(
    () => filtrarPacientes(props.patients, props.value ? '' : texto),
    [props.patients, props.value, texto],
  )
  // A ultima opcao da lista e sempre "cadastrar".
  const total = resultados.length + 1
  const termo = texto.trim()

  function escolher(paciente: PatientOption): void {
    props.onChange(paciente.id)
    setTexto(paciente.name)
    setAberto(false)
  }

  function abrirCadastro(): void {
    const valor = props.value ? '' : termo
    setCadastro(pareceTelefone(valor) ? { name: '', phone: valor } : { name: valor, phone: '' })
    setErro(null)
    setAberto(false)
  }

  async function cadastrar(): Promise<void> {
    if (!cadastro || salvando) return
    if (cadastro.name.trim().length < 2) return setErro('Informe o nome do paciente.')
    if (digitos(cadastro.phone).length < 10) return setErro('Informe o telefone com DDD.')
    setSalvando(true)
    setErro(null)
    const r = await quickCreatePatientAction(cadastro)
    setSalvando(false)
    if (!r.ok) {
      setErro(r.error)
      return
    }
    props.onCreated(r.patient)
    escolher(r.patient)
    setCadastro(null)
  }

  function teclaNaBusca(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setAberto(true)
      setAtivo((i) => (i + 1) % total)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setAberto(true)
      setAtivo((i) => (i - 1 + total) % total)
    } else if (e.key === 'Enter') {
      // Enter na busca escolhe; nunca envia o agendamento por engano.
      e.preventDefault()
      if (!aberto) return setAberto(true)
      const escolhido = resultados[ativo]
      if (escolhido) escolher(escolhido)
      else abrirCadastro()
    } else if (e.key === 'Escape' && aberto) {
      e.preventDefault()
      setAberto(false)
    }
  }

  function teclaNoCadastro(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      void cadastrar()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setCadastro(null)
    }
  }

  const opcaoId = (i: number) => `${listId}-${i}`

  return (
    <div className="picker">
      <input
        id={props.inputId}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={aberto}
        aria-controls={listId}
        aria-activedescendant={aberto ? opcaoId(ativo) : undefined}
        placeholder="Digite o nome ou o telefone"
        value={texto}
        disabled={cadastro !== null}
        onChange={(e) => {
          setTexto(e.target.value)
          setAberto(true)
          setAtivo(0)
          // Digitar desfaz a escolha: o que esta escrito e o que vale.
          if (props.value) props.onChange('')
        }}
        onFocus={() => setAberto(true)}
        onBlur={() => setAberto(false)}
        onKeyDown={teclaNaBusca}
      />

      {aberto && cadastro === null ? (
        <ul id={listId} role="listbox" className="picker-list">
          {resultados.map((p, i) => (
            <li
              key={p.id}
              id={opcaoId(i)}
              role="option"
              aria-selected={i === ativo}
              className={i === ativo ? 'active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault()
                escolher(p)
              }}
              onMouseEnter={() => setAtivo(i)}
            >
              <span>{p.name}</span>
              <span className="faint">{formatPhone(p.phone)}</span>
            </li>
          ))}
          {resultados.length === 0 ? (
            <li className="picker-empty" aria-hidden>
              Nenhum paciente encontrado
            </li>
          ) : null}
          <li
            id={opcaoId(resultados.length)}
            role="option"
            aria-selected={ativo === resultados.length}
            className={`picker-new ${ativo === resultados.length ? 'active' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault()
              abrirCadastro()
            }}
            onMouseEnter={() => setAtivo(resultados.length)}
          >
            {termo && !props.value ? `+ Cadastrar "${termo}"` : '+ Cadastrar novo paciente'}
          </li>
        </ul>
      ) : null}

      {cadastro ? (
        <div className="picker-create" role="group" aria-label="Novo paciente">
          <p className="picker-create-title">Novo paciente</p>
          <label>
            Nome
            <input
              type="text"
              value={cadastro.name}
              autoFocus={cadastro.name === ''}
              onChange={(e) => setCadastro({ ...cadastro, name: e.target.value })}
              onKeyDown={teclaNoCadastro}
            />
          </label>
          <label>
            Telefone
            <input
              type="tel"
              placeholder="(11) 90000-0000"
              value={cadastro.phone}
              autoFocus={cadastro.name !== ''}
              onChange={(e) => setCadastro({ ...cadastro, phone: e.target.value })}
              onKeyDown={teclaNoCadastro}
            />
          </label>
          <p className="faint">Nascimento e convênio podem ser completados depois, na ficha.</p>
          {erro ? (
            <p className="error" role="alert">
              {erro}
            </p>
          ) : null}
          <div className="picker-create-actions">
            <button type="button" className="secondary sm" onClick={() => setCadastro(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="sm"
              disabled={salvando}
              onClick={() => void cadastrar()}
            >
              {salvando ? 'Cadastrando…' : 'Cadastrar e selecionar'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
