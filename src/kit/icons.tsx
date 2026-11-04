// A small set of line icons (24px grid, currentColor) so UIs do not need an icon dependency.
import type { SVGProps } from 'react'

const PATHS: Record<string, string> = {
  'arrow-up': 'M12 19V5M5.5 11.5 12 5l6.5 6.5',
  stop: 'M7.5 7.5h9v9h-9z',
  plus: 'M12 5v14M5 12h14',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-right': 'm9 6 6 6-6 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  compose: 'M12 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5V12M17.5 4.5l2 2L12 14l-3 1 1-3 7.5-7.5Z',
  sidebar: 'M5 5h14v14H5zM10 5v14',
  plug: 'M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8ZM12 17v4',
  archive: 'M4 5h16v4H4zM6 9v10h12V9M10 13h4',
  x: 'M6 6l12 12M18 6 6 18',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  spark: 'M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5',
  wrench: 'M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.500-5.500a4 4 0 0 0 5-5L15 12l-2.500-2.500 2-3Z',
  link: 'M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1',
  'arrow-left': 'M19 12H5M11.5 5.5 5 12l6.5 6.500',
  pointer: 'M5 4l5.500 15 2.500-6 6-2.500L5 4ZM14 14l5 5',
  paperclip: 'm16 6-8.400 8.600a2 2 0 0 0 2.800 2.800l8.400-8.600a4 4 0 1 0-5.700-5.700l-8.400 8.600a6 6 0 1 0 8.500 8.500l8.400-8.600',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5',
  terminal: 'M4 5h16v14H4zM8 10l2.5 2.5L8 15M13 15h3',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
}
export type IconName = 'arrow-up' | 'stop' | 'plus' | 'check' | 'copy' | 'chevron-down' | 'chevron-right' | 'search' | 'compose' | 'sidebar' | 'plug' | 'archive' | 'x' | 'dots' | 'spark' | 'wrench' | 'link' | 'arrow-left' | 'pointer' | 'paperclip' | 'file' | 'terminal' | 'mic'

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={name === 'stop' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={name === 'dots' ? 2.6 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      <path d={PATHS[name]} />
    </svg>
  )
}
