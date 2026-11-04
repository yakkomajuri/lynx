// A small button that is only an icon, for what can be done to a row.
import type { ReactNode } from 'react'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** A small button that is only an icon; `label` is what it does. */
export const IconAction = ({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) => (
  <button className={cx('h-dicon', danger && 'danger')} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
    {children}
  </button>
)
