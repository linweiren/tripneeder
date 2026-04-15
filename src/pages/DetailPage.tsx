import {
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Link, useParams } from 'react-router-dom'
import type {
  PublicTransitType,
  Stop,
  StopType,
  TransportMode,
  TransportSegment,
} from '../types/trip'
import { loadGeneratedPlans, loadLastTripInput } from '../utils/tripPlanStorage'

type OrderMode = 'main' | 'rain'

const stopTypeLabels: Record<StopType, string> = {
  main_activity: '主要景點',
  food: '餐飲補給',
  ending_or_transition: '收尾轉場',
}

const transportLabels: Record<TransportMode, string> = {
  scooter: '機車',
  car: '汽車',
  public_transit: '大眾運輸',
}

const transportIcons: Record<TransportMode, string> = {
  scooter: '機車',
  car: '汽車',
  public_transit: '公車',
}

const publicTransitLabels: Record<PublicTransitType, string> = {
  bus: '公車',
  metro: '捷運',
  train: '火車',
  walk: '步行',
  mixed: '大眾',
}

export function DetailPage() {
  const { planId } = useParams()
  const plans = loadGeneratedPlans()
  const lastInput = loadLastTripInput()
  const selectedPlan = plans.find((plan) => plan.id === planId)
  const [isRainMode, setIsRainMode] = useState(false)
  const [keptStops, setKeptStops] = useState<Set<string>>(() => new Set())
  const [stopOrders, setStopOrders] = useState<Partial<Record<OrderMode, string[]>>>(
    {},
  )
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const orderMode: OrderMode = isRainMode ? 'rain' : 'main'

  const baseStops = useMemo(() => {
    if (!selectedPlan) {
      return []
    }

    return isRainMode ? selectedPlan.rainBackup : selectedPlan.stops
  }, [isRainMode, selectedPlan])

  const rawTransportSegments = useMemo(() => {
    if (!selectedPlan) {
      return []
    }

    return isRainMode
      ? selectedPlan.rainTransportSegments
      : selectedPlan.transportSegments
  }, [isRainMode, selectedPlan])

  const visibleStops = useMemo(
    () => applyStopOrder(baseStops, stopOrders[orderMode]),
    [baseStops, orderMode, stopOrders],
  )

  const visibleTransportSegments = useMemo(() => {
    if (!selectedPlan) {
      return []
    }

    return getTransportSegments(
      rawTransportSegments,
      visibleStops,
      baseStops,
      selectedPlan.transportMode,
    )
  }, [baseStops, rawTransportSegments, selectedPlan, visibleStops])

  const shouldShowLegacyNotice = useMemo(
    () =>
      visibleStops.some((stop) => !stop.id) ||
      visibleTransportSegments.some((segment) => !segment.label),
    [visibleStops, visibleTransportSegments],
  )

  const stopRows = useMemo(
    () =>
      buildStopRows(visibleStops, visibleTransportSegments, lastInput?.startTime),
    [lastInput?.startTime, visibleStops, visibleTransportSegments],
  )

  const visibleDuration =
    visibleStops.reduce((total, stop) => total + stop.duration, 0) +
    visibleTransportSegments.reduce(
      (total, segment) => total + segment.duration,
      0,
    )

  function toggleKeptStop(stop: Stop, index: number) {
    const key = getStopKey(stop, index, isRainMode)

    setKeptStops((current) => {
      const next = new Set(current)

      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }

      return next
    })
  }

  function handleDragEnd(event: DragEndEvent) {
    if (!selectedPlan || !event.over || event.active.id === event.over.id) {
      return
    }

    const oldIndex = visibleStops.findIndex(
      (stop, index) => getStopId(stop, index) === event.active.id,
    )
    const newIndex = visibleStops.findIndex(
      (stop, index) => getStopId(stop, index) === event.over?.id,
    )

    if (oldIndex < 0 || newIndex < 0) {
      return
    }

    const nextStops = arrayMove(visibleStops, oldIndex, newIndex)
    const nextTransportSegments = getTransportSegments(
      rawTransportSegments,
      nextStops,
      baseStops,
      selectedPlan.transportMode,
    )
    const overDoubleSegment = getOverDoubleTransportSegment(
      nextTransportSegments,
      visibleTransportSegments,
    )

    if (
      overDoubleSegment &&
      !window.confirm(
        `這次排序會讓「${getTransportSegmentLabel(overDoubleSegment.nextSegment)}」交通時間從 ${formatTransportDuration(overDoubleSegment.previousDuration)} 變成 ${formatTransportDuration(overDoubleSegment.nextSegment.duration)}，超過原本 2 倍。確定要保留這次排序嗎？`,
      )
    ) {
      return
    }

    setStopOrders((current) => ({
      ...current,
      [orderMode]: nextStops.map((stop, index) => getStopId(stop, index)),
    }))
  }

  if (!selectedPlan) {
    return (
      <section className="page">
        <Link className="back-link" to="/results">
          重新選擇
        </Link>
        <p className="page-kicker">找不到方案</p>
        <h1 className="page-title">這趟行程暫時讀不到</h1>
        <p className="page-copy">
          請回到三方案結果頁重新選擇，或回首頁再產生一次行程。
        </p>
      </section>
    )
  }

  return (
    <section className="page detail-page">
      <Link className="back-link" to="/results">
        重新選擇
      </Link>

      <div className="detail-hero">
        <p className="page-kicker">{isRainMode ? '雨天備案' : '一般行程'}</p>
        <h1 className="page-title">{selectedPlan.title}</h1>
        <p className="detail-subtitle">{selectedPlan.subtitle}</p>
        <p className="page-copy">{selectedPlan.summary}</p>
      </div>

      <dl className="detail-metrics">
        <div>
          <dt>預估時長</dt>
          <dd>{formatMinutes(visibleDuration || selectedPlan.totalTime)}</dd>
        </div>
        <div>
          <dt>預估預算</dt>
          <dd>約 NT$ {selectedPlan.budget.toLocaleString('zh-TW')}</dd>
        </div>
        <button className="metric-button" type="button">
          <dt>交通方式</dt>
          <dd>{transportLabels[selectedPlan.transportMode]}</dd>
        </button>
      </dl>

      {shouldShowLegacyNotice ? (
        <p className="legacy-data-note">
          目前讀到舊版交通資料，已先以相容模式顯示；重新產生行程後會取得新版交通段資訊。
        </p>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={visibleStops.map((stop, index) => getStopId(stop, index))}
          strategy={verticalListSortingStrategy}
        >
          <div className="timeline">
            {stopRows.map(({ stop, startTime, endTime }, index) => {
          const stopKey = getStopKey(stop, index, isRainMode)
          const isKept = keptStops.has(stopKey)
          const nextSegment = visibleTransportSegments[index]

          return (
            <SortableTimelineGroup id={getStopId(stop, index)} key={stopKey}>
              {(dragHandleProps) => (
                <>
              <article className="timeline-stop">
                <div className="timeline-marker" aria-hidden="true">
                  <span>{index + 1}</span>
                </div>

                <div className="stop-card">
                  <button
                    {...dragHandleProps}
                    className="drag-handle"
                    type="button"
                    aria-label={`拖曳排序 ${stop.name}`}
                  >
                    ↑↓
                  </button>

                  <label className="keep-checkbox">
                    <input
                      type="checkbox"
                      checked={isKept}
                      onChange={() => toggleKeptStop(stop, index)}
                    />
                    <span>保留</span>
                  </label>

                  <div className="stop-time-grid">
                    <div className="stop-time">
                      <span>時段</span>
                      <strong>
                        {startTime && endTime ? `${startTime} ~ ${endTime}` : '依出發時間計算'}
                      </strong>
                    </div>
                    <div className="stop-time">
                      <span>停留</span>
                      <strong>{formatMinutes(stop.duration)}</strong>
                    </div>
                  </div>

                  <div className="stop-heading">
                    <p>{stopTypeLabels[stop.type]}</p>
                    <h2>{stop.name}</h2>
                  </div>

                  <p className="stop-description">
                    {stop.description || '請重新產生行程，AI 會為這個景點補上具體簡介。'}
                  </p>

                  <dl className="stop-details">
                    <div>
                      <dt>地址</dt>
                      <dd>{stop.address}</dd>
                    </div>
                  </dl>

                  <div className="stop-actions">
                    {stop.googleMapsUrl ? (
                      <a
                        className="maps-link"
                        href={stop.googleMapsUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        開啟 Google Maps
                      </a>
                    ) : null}
                    <a
                      className="maps-link"
                      href={buildDirectionsUrl(stop, selectedPlan.transportMode)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      開始導航
                    </a>
                  </div>
                </div>
              </article>

              {nextSegment ? (
                <div className="transport-quick-view">
                  <button className="transport-icon" type="button">
                    {getTransportButtonLabel(nextSegment)}
                  </button>
                  <div>
                    <p>{getTransportSegmentLabel(nextSegment)}</p>
                    <strong>{formatTransportDuration(nextSegment.duration)}</strong>
                  </div>
                </div>
              ) : null}
                </>
              )}
            </SortableTimelineGroup>
          )
            })}
          </div>
        </SortableContext>
      </DndContext>

      <div className="rain-toggle-panel">
        <div>
          <h2>{isRainMode ? '切回一般行程' : '需要雨天備案嗎？'}</h2>
          <p>
            {isRainMode
              ? '切回原本安排，繼續查看一般天氣下的完整時間軸。'
              : '如果天氣不穩，可以把上方詳情整組切換成室內或雨天友善安排。'}
          </p>
        </div>
        <button
          className="submit-button"
          type="button"
          onClick={() => setIsRainMode((current) => !current)}
        >
          {isRainMode ? '查看一般行程' : '切換雨天備案'}
        </button>
      </div>
    </section>
  )
}

function buildStopRows(
  stops: Stop[],
  transportSegments: TransportSegment[],
  startTime?: string,
) {
  let cursor = parseTimeToMinutes(startTime)

  return stops.map((stop, index) => {
    const start = cursor
    const end = typeof cursor === 'number' ? cursor + stop.duration : null

    cursor =
      typeof end === 'number'
        ? end + (transportSegments[index]?.duration ?? 0)
        : end

    return {
      stop,
      startTime: typeof start === 'number' ? formatClockTime(start) : null,
      endTime: typeof end === 'number' ? formatClockTime(end) : null,
    }
  })
}

function SortableTimelineGroup({
  id,
  children,
}: {
  id: string
  children: (dragHandleProps: ButtonHTMLAttributes<HTMLButtonElement>) => ReactNode
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      className={`timeline-group${isDragging ? ' timeline-group-dragging' : ''}`}
      style={style}
    >
      {children({
        ...attributes,
        ...listeners,
      } as ButtonHTMLAttributes<HTMLButtonElement>)}
    </div>
  )
}

function applyStopOrder(stops: Stop[], orderIds?: string[]) {
  if (!orderIds || orderIds.length !== stops.length) {
    return stops
  }

  const stopById = new Map(
    stops.map((stop, index) => [getStopId(stop, index), stop]),
  )
  const orderedStops = orderIds
    .map((id) => stopById.get(id))
    .filter((stop): stop is Stop => Boolean(stop))

  return orderedStops.length === stops.length ? orderedStops : stops
}

function getOverDoubleTransportSegment(
  nextSegments: TransportSegment[],
  previousSegments: TransportSegment[],
) {
  for (const [index, nextSegment] of nextSegments.entries()) {
    const previousDuration = previousSegments[index]?.duration

    if (
      typeof previousDuration === 'number' &&
      previousDuration > 0 &&
      nextSegment.duration > previousDuration * 2
    ) {
      return {
        nextSegment,
        previousDuration,
      }
    }
  }

  return null
}

function getTransportSegments(
  segments: unknown,
  orderedStops: Stop[],
  originalStops: Stop[],
  fallbackMode: TransportMode,
) {
  const baseSegments = getBaseTransportSegments(
    segments,
    originalStops,
    fallbackMode,
  )

  return buildTransportSegmentsForOrder(
    orderedStops,
    originalStops,
    baseSegments,
    fallbackMode,
  )
}

function getBaseTransportSegments(
  segments: unknown,
  stops: Stop[],
  fallbackMode: TransportMode,
) {
  if (Array.isArray(segments) && segments.length === Math.max(stops.length - 1, 0)) {
    const normalizedSegments = segments.map((segment, index) =>
      normalizeTransportSegment(segment, stops, fallbackMode, index),
    )

    if (normalizedSegments.every(isTransportSegmentValue)) {
      return normalizedSegments
    }
  }

  return stops.slice(0, -1).map((stop, index) => ({
    fromStopId: getStopId(stop, index),
    toStopId: getStopId(stops[index + 1], index + 1),
    mode: fallbackMode,
    duration: estimateLegacyTransportDuration(stop.transport),
    label: buildTransportFallbackLabel(fallbackMode),
  }))
}

function buildTransportSegmentsForOrder(
  orderedStops: Stop[],
  originalStops: Stop[],
  baseSegments: TransportSegment[],
  fallbackMode: TransportMode,
) {
  const averageDuration =
    Math.round(
      baseSegments.reduce((total, segment) => total + segment.duration, 0) /
        Math.max(baseSegments.length, 1),
    ) || 20
  const originalIndexById = new Map(
    originalStops.map((stop, index) => [getStopId(stop, index), index]),
  )

  return orderedStops.slice(0, -1).map((stop, index) => {
    const fromStopId = getStopId(stop, index)
    const toStopId = getStopId(orderedStops[index + 1], index + 1)
    const existingSegment = findReusableTransportSegment(
      baseSegments,
      fromStopId,
      toStopId,
    )

    if (existingSegment) {
      return {
        ...existingSegment,
        fromStopId,
        toStopId,
      }
    }

    const estimatedDuration = estimateReorderedTransportDuration(
      fromStopId,
      toStopId,
      originalIndexById,
      baseSegments,
      averageDuration,
    )

    return {
      fromStopId,
      toStopId,
      mode: fallbackMode,
      duration: estimatedDuration,
      label: buildTransportFallbackLabel(fallbackMode),
    }
  })
}

function findReusableTransportSegment(
  segments: TransportSegment[],
  fromStopId: string,
  toStopId: string,
) {
  return segments.find(
    (segment) =>
      (segment.fromStopId === fromStopId && segment.toStopId === toStopId) ||
      (segment.fromStopId === toStopId && segment.toStopId === fromStopId),
  )
}

function estimateReorderedTransportDuration(
  fromStopId: string,
  toStopId: string,
  originalIndexById: Map<string, number>,
  baseSegments: TransportSegment[],
  averageDuration: number,
) {
  const fromIndex = originalIndexById.get(fromStopId)
  const toIndex = originalIndexById.get(toStopId)

  if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
    return averageDuration
  }

  const startIndex = Math.min(fromIndex, toIndex)
  const endIndex = Math.max(fromIndex, toIndex)
  const estimatedDuration = baseSegments
    .slice(startIndex, endIndex)
    .reduce((total, segment) => total + segment.duration, 0)

  return estimatedDuration || averageDuration
}

function normalizeTransportSegment(
  segment: unknown,
  stops: Stop[],
  fallbackMode: TransportMode,
  index: number,
): TransportSegment | null {
  if (!isRecord(segment)) {
    return null
  }

  const mode = isTransportMode(segment.mode) ? segment.mode : fallbackMode
  const duration =
    typeof segment.duration === 'number' && segment.duration >= 0
      ? segment.duration
      : 20
  const publicTransitType = isPublicTransitType(segment.publicTransitType)
    ? segment.publicTransitType
    : undefined
  const fromStopId =
    typeof segment.fromStopId === 'string'
      ? segment.fromStopId
      : getStopId(stops[index], index)
  const toStopId =
    typeof segment.toStopId === 'string'
      ? segment.toStopId
      : getStopId(stops[index + 1], index + 1)

  if (fromStopId !== getStopId(stops[index], index)) {
    return null
  }

  if (toStopId !== getStopId(stops[index + 1], index + 1)) {
    return null
  }

  return {
    fromStopId,
    toStopId,
    mode,
    publicTransitType,
    duration,
    label:
      typeof segment.label === 'string' && segment.label.trim()
        ? cleanTransportSummary(segment.label, mode, publicTransitType)
        : buildTransportFallbackLabel(mode, publicTransitType),
  }
}

function estimateLegacyTransportDuration(transport?: string) {
  const matchedMinutes = transport?.match(/(\d+)\s*分/)

  if (matchedMinutes) {
    return Number(matchedMinutes[1])
  }

  return 20
}

function parseTimeToMinutes(value?: string) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) {
    return null
  }

  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function formatClockTime(totalMinutes: number) {
  const minutesInDay = 24 * 60
  const normalized = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay
  const hour = Math.floor(normalized / 60)
  const minute = normalized % 60

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60

  if (hours === 0) {
    return `${restMinutes} 分鐘`
  }

  if (restMinutes === 0) {
    return `${hours} 小時`
  }

  return `${hours} 小時 ${restMinutes} 分鐘`
}

function formatTransportDuration(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60

  if (hours === 0) {
    return `${restMinutes} 分`
  }

  if (restMinutes === 0) {
    return `${hours} 小時`
  }

  return `${hours} 小時 ${restMinutes} 分`
}

function getTransportButtonLabel(segment: TransportSegment) {
  if (segment.mode === 'public_transit' && segment.publicTransitType) {
    return publicTransitLabels[segment.publicTransitType]
  }

  return transportIcons[segment.mode]
}

function getTransportSegmentLabel(segment: TransportSegment) {
  if (segment.label) {
    return cleanTransportSummary(
      segment.label,
      segment.mode,
      segment.publicTransitType,
    )
  }

  if (segment.mode === 'public_transit' && segment.publicTransitType) {
    return publicTransitLabels[segment.publicTransitType]
  }

  return transportLabels[segment.mode]
}

function getStopKey(stop: Stop, index: number, isRainMode: boolean) {
  return `${isRainMode ? 'rain' : 'main'}-${getStopId(stop, index)}`
}

function buildDirectionsUrl(stop: Stop, mode: TransportMode) {
  const destination = encodeURIComponent(stop.address || stop.name)
  const travelMode = mode === 'public_transit' ? 'transit' : 'driving'

  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=${travelMode}`
}

function getStopId(stop: Stop | undefined, index: number) {
  if (stop?.id) {
    return stop.id
  }

  return `legacy-stop-${stop?.name ?? 'unknown'}-${stop?.address ?? index}`
}

function buildTransportFallbackLabel(
  mode: TransportMode,
  publicTransitType?: PublicTransitType,
) {
  if (mode === 'public_transit' && publicTransitType) {
    return `${publicTransitLabels[publicTransitType]}接駁前往`
  }

  if (mode === 'public_transit') {
    return '大眾運輸前往'
  }

  if (mode === 'scooter') {
    return '騎車順路前往'
  }

  return '開車順路前往'
}

function cleanTransportSummary(
  value: string,
  mode: TransportMode,
  publicTransitType?: PublicTransitType,
) {
  const cleaned = value
    .replace(/[0-9０-９]+\s*(?:小時|分鐘|分|公里|km|KM)/g, '')
    .replace(/約\s*(?:小時|分鐘|分|公里)?/g, '')
    .replace(/\s+/g, '')
    .replace(/[，,、。．.]+$/g, '')
    .trim()

  return cleaned || buildTransportFallbackLabel(mode, publicTransitType)
}

function isTransportMode(value: unknown): value is TransportMode {
  return value === 'scooter' || value === 'car' || value === 'public_transit'
}

function isPublicTransitType(value: unknown): value is PublicTransitType {
  return (
    value === 'bus' ||
    value === 'metro' ||
    value === 'train' ||
    value === 'walk' ||
    value === 'mixed'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTransportSegmentValue(
  value: TransportSegment | null,
): value is TransportSegment {
  return value !== null
}
