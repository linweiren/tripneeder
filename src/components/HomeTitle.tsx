export function HomeTitle() {
  return (
    <h1 className="home-title" aria-label="想在這玩多久？">
      <svg
        aria-hidden="true"
        className="home-title-art"
        viewBox="0 0 390 82"
        focusable="false"
      >
        <defs>
          <filter id="homeTitlePress" x="-6%" y="-30%" width="112%" height="170%">
            <feDropShadow
              dx="0"
              dy="1"
              floodColor="#fffaf2"
              floodOpacity="0.88"
              stdDeviation="0"
            />
            <feDropShadow
              dx="0"
              dy="8"
              floodColor="#302b22"
              floodOpacity="0.09"
              stdDeviation="7"
            />
          </filter>
          <linearGradient id="homeTitleBrush" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#f2c9a8" stopOpacity="0.58" />
            <stop offset="100%" stopColor="#a7b59a" stopOpacity="0.36" />
          </linearGradient>
        </defs>

        <path
          className="home-title-brush"
          d="M202 56 C224 48 256 50 296 53 C301 53 304 58 299 61 C270 68 228 68 201 63 C196 62 197 58 202 56 Z"
          fill="url(#homeTitleBrush)"
        />
        <text className="home-title-text" x="0" y="49" filter="url(#homeTitlePress)">
          <tspan>想在這玩</tspan>
          <tspan className="home-title-keyword" dx="4">多久</tspan>
          <tspan dx="2">？</tspan>
        </text>
      </svg>
    </h1>
  )
}

export default HomeTitle
