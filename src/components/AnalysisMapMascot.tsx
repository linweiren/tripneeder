import { useId } from 'react'
import mascotMapReference from '../assets/mascot/mascot-map-reference.png'

type AnalysisMapMascotProps = {
  className?: string
}

export function AnalysisMapMascot({ className = '' }: AnalysisMapMascotProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const bodyMaskId = `${id}-body-mask`
  const headClipId = `${id}-head-clip`

  return (
    <svg
      className={['analysis-map-mascot', 'analysis-map-mascot-svg', className]
        .filter(Boolean)
        .join(' ')}
      viewBox="0 0 884 1058"
      role="img"
      aria-labelledby={`${id}-title`}
    >
      <title id={`${id}-title`}>TripNeeder 奶油白旅行貓查看地圖</title>
      <defs>
        <mask id={bodyMaskId} maskUnits="userSpaceOnUse">
          <rect width="884" height="1058" fill="white" />
          <path
            d="M128 0H764V496C640 550 378 566 142 462Z"
            fill="black"
          />
        </mask>
        <clipPath id={headClipId}>
          <path d="M128 0H764V496C640 550 378 566 142 462Z" />
        </clipPath>
      </defs>

      <g className="sleepy-map-body" mask={`url(#${bodyMaskId})`}>
        <image
          href={mascotMapReference}
          width="884"
          height="1058"
          preserveAspectRatio="xMidYMid meet"
        />
      </g>
      <g className="sleepy-map-head" clipPath={`url(#${headClipId})`}>
        <image
          href={mascotMapReference}
          width="884"
          height="1058"
          preserveAspectRatio="xMidYMid meet"
        />
      </g>
    </svg>
  )
}

export default AnalysisMapMascot
