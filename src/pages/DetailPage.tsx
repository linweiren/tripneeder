import {
  useEffect,
  useMemo,
  useRef,
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
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import type {
  PublicTransitType,
  Stop,
  StopType,
  TransportMode,
  TransportSegment,
  TripPlan,
} from '../types/trip'
import {
  loadInputForDetail,
  loadGeneratedPlans,
  loadLastTripInput,
  loadPlanForDetail,
} from '../utils/tripPlanStorage'
import {
  isFavoriteRecord,
  saveFavoriteRecord,
} from '../services/tripRecords/tripRecordService'
import { useAnalysisSession } from '../contexts/analysisSession'
import { useAuth } from '../contexts/auth'
import { useDialog, type DialogContextValue } from '../contexts/dialog'

type OrderMode = 'main' | 'rain'
type SegmentModeOverrides = Partial<Record<OrderMode, Record<string, TransportMode>>>

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
  public_transit: '大眾',
}

const transportOptions: TransportMode[] = ['scooter', 'car', 'public_transit']
const transportSpeed: Record<TransportMode, number> = {
  scooter: 40,
  car: 60,
  public_transit: 28,
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
  const navigate = useNavigate()
  const location = useLocation()
  const { setFlowRoute } = useAnalysisSession()
  const { user } = useAuth()
  const dialog = useDialog()
  const plans = loadGeneratedPlans()
  const sourcePage = getDetailSource(location.state)
  const isStoredSource = sourcePage === 'favorites' || sourcePage === 'recent'
  const storedDetailPlan = loadPlanForDetail(planId)
  const generatedPlan = plans.find((plan) => plan.id === planId)
  const selectedPlan = isStoredSource
    ? storedDetailPlan ?? generatedPlan
    : generatedPlan ?? storedDetailPlan
  const lastInput =
    selectedPlan === storedDetailPlan ? loadInputForDetail() : loadLastTripInput()
  const [isRainMode, setIsRainMode] = useState(false)
  const [stopOrders, setStopOrders] = useState<Partial<Record<OrderMode, string[]>>>(
    {},
  )
  const [transportModeOverrides, setTransportModeOverrides] = useState<
    Partial<Record<OrderMode, TransportMode>>
  >({})
  const [segmentModeOverrides, setSegmentModeOverrides] =
    useState<SegmentModeOverrides>({})
  const [isGlobalTransportMenuOpen, setIsGlobalTransportMenuOpen] =
    useState(false)
  const [openSegmentMenuKey, setOpenSegmentMenuKey] = useState<string | null>(null)
  const [favoriteRevision, setFavoriteRevision] = useState(0)
  const [hasSavedFavorite, setHasSavedFavorite] = useState(false)
  const [isSavingFavorite, setIsSavingFavorite] = useState(false)
  const favoriteStatusRequestIdRef = useRef(0)
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
  const activeTransportMode =
    transportModeOverrides[orderMode] ??
    getFirstSegmentMode(rawTransportSegments) ??
    selectedPlan?.transportMode ??
    'scooter'

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
      activeTransportMode,
    )
  }, [activeTransportMode, baseStops, rawTransportSegments, selectedPlan, visibleStops])

  const visibleTransportSegmentsWithOverrides = useMemo(
    () =>
      applySegmentModeOverrides(
        getGloballyAppliedTransportSegments(
          visibleTransportSegments,
          activeTransportMode,
          transportModeOverrides[orderMode],
        ),
        segmentModeOverrides[orderMode],
      ),
    [
      activeTransportMode,
      orderMode,
      segmentModeOverrides,
      transportModeOverrides,
      visibleTransportSegments,
    ],
  )

  const shouldShowLegacyNotice = useMemo(
    () =>
      visibleStops.some((stop) => !stop.id) ||
      visibleTransportSegmentsWithOverrides.some((segment) => !segment.label),
    [visibleStops, visibleTransportSegmentsWithOverrides],
  )

  const stopRows = useMemo(
    () =>
      buildStopRows(
        visibleStops,
        visibleTransportSegmentsWithOverrides,
        lastInput?.startTime,
      ),
    [lastInput?.startTime, visibleStops, visibleTransportSegmentsWithOverrides],
  )

  const visibleDuration =
    visibleStops.reduce((total, stop) => total + stop.duration, 0) +
    visibleTransportSegmentsWithOverrides.reduce(
      (total, segment) => total + segment.duration,
      0,
    )
  const allowedTripMinutes = getAllowedTripMinutes(lastInput?.startTime, lastInput?.endTime)

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [planId])

  useEffect(() => {
    function refreshFavoriteStatus() {
      setFavoriteRevision((current) => current + 1)
    }

    window.addEventListener('focus', refreshFavoriteStatus)
    window.addEventListener('pageshow', refreshFavoriteStatus)
    window.addEventListener('tripneeder:favoritesChanged', refreshFavoriteStatus)

    return () => {
      window.removeEventListener('focus', refreshFavoriteStatus)
      window.removeEventListener('pageshow', refreshFavoriteStatus)
      window.removeEventListener('tripneeder:favoritesChanged', refreshFavoriteStatus)
    }
  }, [])

  useEffect(() => {
    if (!selectedPlan || !user || isSavingFavorite) {
      return
    }

    let isMounted = true
    const requestId = favoriteStatusRequestIdRef.current + 1
    favoriteStatusRequestIdRef.current = requestId
    const plan = buildSnapshotPlan({
      plan: selectedPlan,
      stopOrders,
      transportModeOverrides,
      segmentModeOverrides,
    })
    const userId = user.id

    async function loadFavoriteStatus() {
      const isFavorite = await isFavoriteRecord(plan, userId)

      if (isMounted && requestId === favoriteStatusRequestIdRef.current) {
        setHasSavedFavorite(isFavorite)
      }
    }

    void loadFavoriteStatus()

    return () => {
      isMounted = false
    }
  }, [
    favoriteRevision,
    isSavingFavorite,
    segmentModeOverrides,
    selectedPlan,
    stopOrders,
    transportModeOverrides,
    user,
  ])

  async function handleDragEnd(event: DragEndEvent) {
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
      activeTransportMode,
    )
    const nextSegmentsWithOverrides = applySegmentModeOverrides(
      nextTransportSegments,
      segmentModeOverrides[orderMode],
    )
    const overDoubleSegment = getOverDoubleTransportSegment(
      nextSegmentsWithOverrides,
      visibleTransportSegmentsWithOverrides,
    )

    if (
      overDoubleSegment &&
      !(await dialog.confirm({
        title: '交通時間變長',
        message: `這次排序會讓「${getTransportSegmentLabel(overDoubleSegment.nextSegment)}」交通時間從 ${formatTransportDuration(overDoubleSegment.previousDuration)} 變成 ${formatTransportDuration(overDoubleSegment.nextSegment.duration)}，超過原本 2 倍。確定要保留這次排序嗎？`,
        confirmLabel: '保留排序',
      }))
    ) {
      return
    }

    setStopOrders((current) => ({
      ...current,
      [orderMode]: nextStops.map((stop, index) => getStopId(stop, index)),
    }))
  }

  async function applyGlobalTransportMode(nextMode: TransportMode) {
    if (!selectedPlan || nextMode === activeTransportMode) {
      setIsGlobalTransportMenuOpen(false)
      return
    }

    const nextSegments = visibleTransportSegmentsWithOverrides.map((segment) =>
      applyTransportMode(segment, nextMode),
    )
    const nextDuration = getTotalVisibleDuration(visibleStops, nextSegments)

    if (!(await confirmTransportChange(nextDuration, allowedTripMinutes, dialog))) {
      setIsGlobalTransportMenuOpen(false)
      return
    }

    setTransportModeOverrides((current) => ({
      ...current,
      [orderMode]: nextMode,
    }))
    setSegmentModeOverrides((current) => ({
      ...current,
      [orderMode]: {},
    }))
    setIsGlobalTransportMenuOpen(false)
  }

  async function handleSaveFavorite() {
    if (!selectedPlan || !user || hasSavedFavorite || isSavingFavorite) {
      return
    }

    const snapshotPlan = buildSnapshotPlan({
      plan: selectedPlan,
      stopOrders,
      transportModeOverrides,
      segmentModeOverrides,
    })

    try {
      favoriteStatusRequestIdRef.current += 1
      setIsSavingFavorite(true)
      setHasSavedFavorite(true)
      await saveFavoriteRecord(snapshotPlan, lastInput, user.id)
      setFavoriteRevision((current) => current + 1)
    } catch (error) {
      setHasSavedFavorite(await isFavoriteRecord(snapshotPlan, user.id))
      setFavoriteRevision((current) => current + 1)
      void dialog.alert({
        title: '收藏同步失敗',
        message:
          error instanceof Error ? error.message : '收藏同步失敗，請稍後再試。',
      })
    } finally {
      setIsSavingFavorite(false)
    }
  }

  async function applySingleSegmentTransportMode(
    segment: TransportSegment,
    nextMode: TransportMode,
  ) {
    const segmentKey = getSegmentKey(segment)
    const nextSegments = visibleTransportSegmentsWithOverrides.map((currentSegment) =>
      getSegmentKey(currentSegment) === segmentKey
        ? applyTransportMode(currentSegment, nextMode)
        : currentSegment,
    )
    const nextDuration = getTotalVisibleDuration(visibleStops, nextSegments)

    if (!(await confirmTransportChange(nextDuration, allowedTripMinutes, dialog))) {
      setOpenSegmentMenuKey(null)
      return
    }

    setSegmentModeOverrides((current) => ({
      ...current,
      [orderMode]: {
        ...(current[orderMode] ?? {}),
        [segmentKey]: nextMode,
      },
    }))
    setOpenSegmentMenuKey(null)
  }

  if (!selectedPlan) {
    return (
      <section className="page">
        <DetailBackControl isStoredSource={isStoredSource} onBack={() => navigate(-1)} />
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
      <DetailBackControl
        isStoredSource={isStoredSource}
        onBack={() => navigate(-1)}
        onReturnToResults={() => setFlowRoute('/results')}
      />

      <div className="detail-hero">
        <p className="page-kicker">{isRainMode ? '雨天備案' : '一般行程'}</p>
        <h1 className="page-title">{selectedPlan.title}</h1>
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
        <div className="metric-transport-card">
          <dt>交通方式</dt>
          <dd>{transportLabels[activeTransportMode]}</dd>
          <div className="transport-switch-area">
            <button
              className="transport-switch-button"
              type="button"
              onClick={() => setIsGlobalTransportMenuOpen((current) => !current)}
            >
              切換
            </button>
            {isGlobalTransportMenuOpen ? (
              <TransportModeMenu
                activeMode={activeTransportMode}
                label="整趟行程交通"
                compact
                alignRight
                onSelect={(nextMode) => void applyGlobalTransportMode(nextMode)}
              />
            ) : null}
          </div>
        </div>
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
          const nextSegment = visibleTransportSegmentsWithOverrides[index]

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
                    href={buildDirectionsUrl(stop, activeTransportMode)}
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
                  <button
                    className="transport-icon"
                    type="button"
                    onClick={() =>
                      setOpenSegmentMenuKey((current) =>
                        current === getSegmentKey(nextSegment)
                          ? null
                          : getSegmentKey(nextSegment),
                      )
                    }
                  >
                    {getTransportButtonLabel(nextSegment)}
                  </button>
                  <div>
                    <p>{getTransportSegmentLabel(nextSegment)}</p>
                    <strong>{formatTransportDuration(nextSegment.duration)}</strong>
                  </div>
                  {openSegmentMenuKey === getSegmentKey(nextSegment) ? (
                    <TransportModeMenu
                      activeMode={nextSegment.mode}
                      label="單段交通"
                      compact
                      onSelect={(nextMode) =>
                        void applySingleSegmentTransportMode(nextSegment, nextMode)
                      }
                    />
                  ) : null}
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

      <div className="detail-action-row">
        <div className="rain-toggle-panel action-strip">
          <button
            className="submit-button"
            type="button"
            onClick={() => setIsRainMode((current) => !current)}
          >
            {isRainMode ? '查看一般行程' : '切換雨天備案'}
          </button>
        </div>

        <div className="favorite-action-panel action-strip">
          <button
            className="submit-button"
            type="button"
            onClick={() => void handleSaveFavorite()}
            disabled={hasSavedFavorite || isSavingFavorite}
          >
            {hasSavedFavorite ? '已收藏' : '收藏此方案'}
          </button>
        </div>
      </div>
    </section>
  )
}

function DetailBackControl({
  isStoredSource,
  onBack,
  onReturnToResults,
}: {
  isStoredSource: boolean
  onBack: () => void
  onReturnToResults?: () => void
}) {
  if (isStoredSource) {
    return (
      <button
        className="back-link back-icon-button"
        type="button"
        aria-label="回上一頁"
        onClick={onBack}
      >
        ←
      </button>
    )
  }

  return (
    <Link className="back-link" to="/results" onClick={onReturnToResults}>
      重新選擇
    </Link>
  )
}

function buildSnapshotPlan({
  plan,
  stopOrders,
  transportModeOverrides,
  segmentModeOverrides,
}: {
  plan: TripPlan
  stopOrders: Partial<Record<OrderMode, string[]>>
  transportModeOverrides: Partial<Record<OrderMode, TransportMode>>
  segmentModeOverrides: SegmentModeOverrides
}): TripPlan {
  const mainMode = transportModeOverrides.main ?? plan.transportMode
  const mainStops = applyStopOrder(plan.stops, stopOrders.main)
  const mainSegments = applySegmentModeOverrides(
    getGloballyAppliedTransportSegments(
      getTransportSegments(plan.transportSegments, mainStops, plan.stops, mainMode),
      mainMode,
      transportModeOverrides.main,
    ),
    segmentModeOverrides.main,
  )

  const rainMode = transportModeOverrides.rain ?? plan.transportMode
  const rainStops = applyStopOrder(plan.rainBackup, stopOrders.rain)
  const rainSegments = applySegmentModeOverrides(
    getGloballyAppliedTransportSegments(
      getTransportSegments(
        plan.rainTransportSegments,
        rainStops,
        plan.rainBackup,
        rainMode,
      ),
      rainMode,
      transportModeOverrides.rain,
    ),
    segmentModeOverrides.rain,
  )

  return {
    ...plan,
    transportMode: mainMode,
    totalTime: getTotalVisibleDuration(mainStops, mainSegments),
    stops: mainStops,
    transportSegments: mainSegments,
    rainBackup: rainStops,
    rainTransportSegments: rainSegments,
  }
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

function TransportModeMenu({
  activeMode,
  label,
  compact = false,
  alignRight = false,
  onSelect,
}: {
  activeMode: TransportMode
  label: string
  compact?: boolean
  alignRight?: boolean
  onSelect: (mode: TransportMode) => void
}) {
  return (
    <div
      className={`transport-mode-menu${compact ? ' transport-mode-menu-compact' : ''}${alignRight ? ' transport-mode-menu-right' : ''}`}
    >
      <p>{label}</p>
      <div>
        {transportOptions.map((mode) => (
          <button
            className={mode === activeMode ? 'transport-mode-active' : ''}
            type="button"
            key={mode}
            onClick={() => onSelect(mode)}
          >
            {transportLabels[mode]}
          </button>
        ))}
      </div>
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

function applySegmentModeOverrides(
  segments: TransportSegment[],
  overrides?: Record<string, TransportMode>,
) {
  if (!overrides) {
    return segments
  }

  return segments.map((segment) => {
    const overrideMode = overrides[getSegmentKey(segment)]

    return overrideMode ? applyTransportMode(segment, overrideMode) : segment
  })
}

function getGloballyAppliedTransportSegments(
  segments: TransportSegment[],
  activeTransportMode: TransportMode,
  globalTransportOverride?: TransportMode,
) {
  if (!globalTransportOverride) {
    return segments
  }

  return segments.map((segment) => applyTransportMode(segment, activeTransportMode))
}

function applyTransportMode(
  segment: TransportSegment,
  nextMode: TransportMode,
): TransportSegment {
  if (segment.mode === nextMode) {
    return segment
  }

  const duration = estimateTransportModeDuration(segment, nextMode)
  const publicTransitType =
    nextMode === 'public_transit' ? segment.publicTransitType : undefined

  return {
    ...segment,
    mode: nextMode,
    publicTransitType,
    duration,
    label: buildTransportFallbackLabel(nextMode, publicTransitType),
  }
}

function estimateTransportModeDuration(
  segment: TransportSegment,
  nextMode: TransportMode,
) {
  const currentSpeed = transportSpeed[segment.mode]
  const nextSpeed = transportSpeed[nextMode]

  return Math.max(5, Math.round(segment.duration * (currentSpeed / nextSpeed)))
}

function getTotalVisibleDuration(stops: Stop[], transportSegments: TransportSegment[]) {
  return (
    stops.reduce((total, stop) => total + stop.duration, 0) +
    transportSegments.reduce((total, segment) => total + segment.duration, 0)
  )
}

function confirmTransportChange(
  nextDuration: number,
  allowedMinutes: number | null,
  dialog: DialogContextValue,
) {
  if (!allowedMinutes) {
    return Promise.resolve(true)
  }

  const isOverTime =
    nextDuration > allowedMinutes * 1.2 || nextDuration > allowedMinutes + 30

  if (!isOverTime) {
    return Promise.resolve(true)
  }

  return dialog.confirm({
    title: '行程可能超時',
    message: `切換後行程預估會變成 ${formatMinutes(nextDuration)}，可能超出你設定的時間。確定要套用這個交通方式嗎？`,
    confirmLabel: '套用交通',
  })
}

function getAllowedTripMinutes(startTime?: string, endTime?: string) {
  const start = parseTimeToMinutes(startTime)
  const end = parseTimeToMinutes(endTime)

  if (typeof start !== 'number' || typeof end !== 'number') {
    return null
  }

  return end >= start ? end - start : end + 24 * 60 - start
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

function getSegmentKey(segment: TransportSegment) {
  return `${segment.fromStopId}->${segment.toStopId}`
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

function getFirstSegmentMode(segments: unknown): TransportMode | null {
  if (!Array.isArray(segments)) {
    return null
  }

  const firstSegment = segments[0]

  if (!isRecord(firstSegment) || !isTransportMode(firstSegment.mode)) {
    return null
  }

  return firstSegment.mode
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

function getDetailSource(value: unknown) {
  if (!isRecord(value)) {
    return null
  }

  return value.from === 'favorites' || value.from === 'recent' ? value.from : null
}

function isTransportSegmentValue(
  value: TransportSegment | null,
): value is TransportSegment {
  return value !== null
}
