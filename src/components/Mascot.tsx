import mascotMain from '../assets/mascot/mascot-main.png'

type MascotSize = 'small' | 'medium' | 'large'
type MascotVariant = 'hero' | 'empty' | 'loading' | 'success'

type MascotProps = {
  size?: MascotSize
  variant?: MascotVariant
  className?: string
}

export function Mascot({
  size = 'medium',
  variant = 'hero',
  className = '',
}: MascotProps) {
  const classNames = [
    'mascot',
    `mascot-${size}`,
    `mascot-${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <figure className={classNames}>
      <img
        src={mascotMain}
        alt="TripNeeder 奶油白旅行貓吉祥物"
        decoding="async"
        loading={variant === 'hero' ? 'eager' : 'lazy'}
      />
    </figure>
  )
}

export default Mascot
