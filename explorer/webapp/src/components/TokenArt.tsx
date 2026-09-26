/** Original vector illustrations for preview tokens. No third-party images or affiliations. */
export function TokenArt({ kind = 'frog', label }: { kind?: string; label: string }) {
  const palette: Record<string, [string, string]> = { frog: ['#c1e581', '#72994f'], cast: ['#a7a0e8', '#5e50b7'], night: ['#243057', '#10172c'], cat: ['#f2c955', '#d89229'], coffee: ['#d1b9a1', '#90735e'], goose: ['#90c9df', '#4d99b7'] };
  const [bg, accent] = palette[kind] || palette.frog;
  return <svg viewBox="0 0 400 320" role="img" aria-label={label} className="token-art" xmlns="http://www.w3.org/2000/svg">
    <rect width="400" height="320" fill={bg} />
    <circle cx="335" cy="-10" r="180" fill={accent} opacity=".2" /><circle cx="5" cy="350" r="205" fill={accent} opacity=".2" />
    <path d="M0 45h400M0 90h400M0 135h400M0 180h400M0 225h400M0 270h400M50 0v320M100 0v320M150 0v320M200 0v320M250 0v320M300 0v320M350 0v320" stroke={accent} strokeOpacity=".1" />
    {kind === 'frog' && <g stroke="#273c21" strokeWidth="5" strokeLinejoin="round">
      <ellipse cx="207" cy="307" rx="129" ry="105" fill="#3b5636" /><path d="M89 185C59 99 121 74 158 107c21-17 59-18 80 0 39-39 99-10 74 70 53 119-270 126-223 8Z" fill="#78b85a" />
      <ellipse cx="136" cy="140" rx="31" ry="34" fill="#f3edce" /><ellipse cx="266" cy="139" rx="31" ry="34" fill="#f3edce" /><circle cx="144" cy="147" r="13" fill="#1b291a" /><circle cx="274" cy="146" r="13" fill="#1b291a" />
      <path d="M107 206c46 37 137 30 186-6" fill="none" /><path d="m192 246 15 43 26-47" fill="#eee4c8" /><path d="m205 254 11-6 9 8-9 44Z" fill="#ee9877" />
      <path d="m90 178 29 6m167-6 29-9" stroke="#548643" />
    </g>}
    {kind === 'cat' && <g shapeRendering="crispEdges">
      <path d="M75 275V64h35v31h35v30h109V95h35V64h35v211Z" fill="#fff0a4" /><path d="M75 64h35v62H75zm214 0h35v62h-35z" fill="#f18d99" />
      <path d="M118 147h57v70h-57zm107 0h57v70h-57z" fill="#3a314c" /><path d="M131 154h18v31h-18zm107 0h18v31h-18z" fill="white" />
      <path d="M186 216h28v16h-28zm-16 31h61v13h-61z" fill="#3a314c" /><path d="M51 226h60v10H51zm238 0h60v10h-60z" fill="#ddaa4b" />
    </g>}
    {kind === 'cast' && <g fill="none" stroke="#e9e5ff" strokeWidth="13">
      <path d="M93 320V151a107 107 0 0 1 214 0v169" /><path d="M120 320V151a80 80 0 0 1 160 0v169" opacity=".7" /><path d="M148 320V151a52 52 0 0 1 104 0v169" opacity=".4" />
      <path d="M170 193h61l-14-18m14 18-14 18" strokeWidth="7" /><circle cx="336" cy="70" r="7" fill="#e9e5ff" stroke="none" />
    </g>}
    {kind === 'night' && <g>
      <circle cx="201" cy="139" r="80" fill="#f2dc99" /><circle cx="234" cy="111" r="74" fill="#243057" /><path d="m74 76 4-14 4 14 14 4-14 4-4 14-4-14-14-4Zm248 83 4-14 4 14 14 4-14 4-4 14-4-14-14-4Z" fill="#f2dc99" />
      <path d="M0 287 76 231l50 29 66-18 73 39 61-24 74 39v24H0Z" fill="#141d35" /><circle cx="285" cy="57" r="3" fill="white" /><circle cx="107" cy="177" r="3" fill="white" />
    </g>}
    {kind === 'coffee' && <g stroke="#473328" strokeWidth="5">
      <ellipse cx="199" cy="267" rx="117" ry="21" fill="#9f7b62" stroke="none" /><path d="M272 143c84-13 72 103-3 81" fill="none" stroke="#f1e4d3" strokeWidth="22" /><path d="M105 130h172v79a66 66 0 0 1-66 63h-40a66 66 0 0 1-66-63Z" fill="#f1e4d3" />
      <ellipse cx="191" cy="130" rx="85" ry="18" fill="#553b2b" /><path d="M164 87c-24-20 23-28 0-49m59 49c-24-20 23-28 0-49" fill="none" stroke="#f1e4d3" strokeWidth="7" strokeLinecap="round" /><path d="m177 194 12 12 22-27" fill="none" stroke="#95663c" strokeWidth="7" />
    </g>}
    {kind === 'goose' && <g stroke="#2a4146" strokeWidth="4" strokeLinejoin="round">
      <path d="M75 260c-5-75 112-57 137-81 20-20-3-79 22-109 20-28 73-16 74 21 1 37-44 35-38 59 33 123-115 151-195 110Z" fill="#f6f5e9" /><path d="m301 88 47 22-49 8Z" fill="#e9a13b" /><circle cx="278" cy="89" r="5" fill="#19292e" /><path d="M109 230c42 37 86 15 106-15" fill="none" stroke="#c4d4d0" strokeWidth="6" /><path d="m204 144 64 18-13 22-48-13Z" fill="#f19763" />
    </g>}
    <text x="22" y="29" fontFamily="monospace" fontSize="10" fill={kind === 'night' ? '#9ba9cf' : '#17221b'} opacity=".65" letterSpacing="2">P2ID COMMUNITY / {label.slice(0, 12).toUpperCase()}</text>
  </svg>;
}
