// Iconos SVG inline, estilo Apple (stroke fino 1.6, currentColor). CONTRACT-V2 §4.
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }

export function Icon({ name, size = 18, ...rest }) {
  const paths = GLYPHS[name] || GLYPHS.dot
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      <g {...P}>{paths}</g>
    </svg>
  )
}

const GLYPHS = {
  dot:        <circle cx="12" cy="12" r="3" />,
  console:    <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  shield:     <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />,
  sun:        <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" /></>,
  moon:       <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  bell:       <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z" /><path d="M10 19a2 2 0 0 0 4 0" /></>,
  camera:     <><rect x="3" y="7" width="18" height="13" rx="2" /><circle cx="12" cy="13.5" r="3.2" /><path d="M8 7l1.5-2h5L16 7" /></>,
  device:     <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h6M9 11h6M9 15h3" /></>,
  rules:      <><path d="M4 6h10M4 12h16M4 18h7" /><circle cx="18" cy="6" r="2" /><circle cx="14" cy="18" r="2" /></>,
  procedure:  <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8l2 2 3-3M8 15l2 2 3-3" /></>,
  balance:    <><path d="M12 3v18M5 7h14" /><path d="M5 7l-2.5 5a3 3 0 0 0 5 0L5 7zM19 7l-2.5 5a3 3 0 0 0 5 0L19 7z" /></>,
  reception:  <><path d="M4 12a8 8 0 0 1 16 0" /><path d="M2 12h2M20 12h2" /><circle cx="12" cy="12" r="2.5" /><path d="M12 14.5V20M9 20h6" /></>,
  site:       <><path d="M3 21h18M5 21V8l7-4 7 4v13" /><path d="M9 21v-5h6v5" /></>,
  users:      <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.7" /></>,
  plus:       <path d="M12 5v14M5 12h14" />,
  check:      <path d="M5 13l4 4 10-11" />,
  x:          <path d="M6 6l12 12M18 6L6 18" />,
  chevron:    <path d="M9 6l6 6-6 6" />,
  edit:       <><path d="M4 20h4l10-10-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  trash:      <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>,
  search:     <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  alert:      <><path d="M12 3l9 16H3z" /><path d="M12 9v5M12 17h.01" /></>,
  bolt:       <path d="M13 2L4 14h6l-1 8 9-12h-6z" />,
  link:       <><path d="M9 15l6-6" /><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1M13 18l-1 1a4 4 0 0 1-6-6l1-1" /></>,
  copy:       <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>,
  online:     <circle cx="12" cy="12" r="5" />,
  logout:     <><path d="M14 8V6a2 2 0 0 0-2-2H5v16h7a2 2 0 0 0 2-2v-2" /><path d="M9 12h11M17 9l3 3-3 3" /></>,
  tag:        <><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" /><circle cx="7.5" cy="7.5" r="1.3" /></>,
  hash:       <path d="M9 4L7 20M17 4l-2 16M5 9h15M4 15h15" />,
  flag:       <><path d="M5 21V4" /><path d="M5 4h12l-2 4 2 4H5" /></>,
  clock:      <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  pause:      <path d="M9 5v14M15 5v14" />,
  play:       <path d="M7 4.5l12 7.5-12 7.5z" />,
  coffee:     <><path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" /><path d="M17 9h2a2.5 2.5 0 0 1 0 5h-2" /><path d="M7 2.5c-.6.8-.6 1.7 0 2.5M11 2.5c-.6.8-.6 1.7 0 2.5" /></>,
  gauge:      <><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 14l4-4" /></>,
  route:      <><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8 17.5h6a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h2.5" /></>,
  text:       <path d="M5 7V5h14v2M12 5v14M9 19h6" />,
  pin:        <><path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z" /><circle cx="12" cy="9" r="2.5" /></>,
  globe:      <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.5 2.5 14.5 0 17M12 3.5c-2.5 2.5-2.5 14.5 0 17" /></>,
  sliders:    <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  filter:     <path d="M3 5h18l-7 8v6l-4-2v-4z" />,
  layers:     <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  video:      <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3z" /></>,
  refresh:    <><path d="M20 11a8 8 0 0 0-14-4M4 5v3h3" /><path d="M4 13a8 8 0 0 0 14 4M20 19v-3h-3" /></>,
  expand:     <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  grid:       <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></>,
  phone:      <path d="M6.5 3h3l1.5 4-2 1.5a12 12 0 0 0 5 5L15.5 11l4 1.5v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4.5 5.2 2 2 0 0 1 6.5 3z" />,
  user:       <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  doc:        <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 13h6M9 17h6" /></>,
  speaker:    <><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8 8 0 0 1 0 12" /></>,
  siren:      <><path d="M5 20h14M7 20v-6a5 5 0 0 1 10 0v6" /><path d="M12 4V2M5.5 6 4 4.5M18.5 6 20 4.5" /></>,
  map:        <><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" /></>,
  building:   <><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" /></>,
  shieldcheck:<><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9 11.5l2 2 4-4" /></>,
  car:        <><path d="M3 13l2-5a2 2 0 0 1 1.9-1.3h10.2A2 2 0 0 1 19 8l2 5v5h-2.5M3 13v5h2.5M3 13h18" /><circle cx="7" cy="18" r="1.6" /><circle cx="17" cy="18" r="1.6" /></>,
  face:       <><circle cx="12" cy="11" r="7.5" /><path d="M9.5 10.5h.01M14.5 10.5h.01M9.5 14c1.3 1.1 3.7 1.1 5 0" /></>,
  linecross:  <><path d="M4 20L20 4" /><path d="M8.5 9.5L12 13l3.5-3.5" /></>,
  zone:       <><path d="M4 9l8-5 8 5v6l-8 5-8-5z" /><circle cx="12" cy="12" r="2.2" /></>,
  plate:      <><rect x="3" y="8" width="18" height="9" rx="1.6" /><path d="M6 11.5h2M10.5 11.5h3M6 14h7" /></>,
}
