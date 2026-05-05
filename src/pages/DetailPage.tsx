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
  VerifiedPlaceCandidate,
} from '../types/trip'
import {
  loadInputForDetail,
  loadGeneratedPlans,
  loadLastTripInput,
  loadPlanForDetail,
  updateDetailPlan,
  updateGeneratedPlan,
} from '../utils/tripPlanStorage'
import {
  isFavoriteRecord,
  saveFavoriteRecord,
  syncUpdatedTripRecordPlan,
  updateStoredTripRecordById,
} from '../services/tripRecords/tripRecordService'
import { useAnalysisSession } from '../contexts/analysisSession'
import type { PlanDetailSource } from '../contexts/analysisSession'
import { useAuth } from '../contexts/auth'
import { useDialog, type DialogContextValue } from '../contexts/dialog'
import * as pointsService from '../services/points/pointsService'

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
  const {
    setFlowRoute,
    planDetailStates,
    requestPlanDetails,
    getReplacementCandidates,
    recomputeTripRoutes,
  } = useAnalysisSession()
  const { user } = useAuth()
  const dialog = useDialog()
  const plans = loadGeneratedPlans()
  const sourcePage = getDetailSource(location.state, location.search)
  const isStoredSource = sourcePage === 'favorites' || sourcePage === 'recent'
  const detailSource: PlanDetailSource = sourcePage ?? 'generated'
  const detailRecordId = isStoredSource ? getDetailRecordId(location.state, location.search) : null
  const storedDetailPlan = loadPlanForDetail(planId)
  const generatedPlan = plans.find((plan) => plan.id === planId)
  const initialSelectedPlan = isStoredSource ? storedDetailPlan : generatedPlan
  // Memoize with stable deps to prevent a new object reference on every render.
  // A new reference would cause the detail-completion useEffect to abort its own fetch
  // each time setDetailCompletionStatus triggers a re-render.
  const lastInput = useMemo(() => {
    return isStoredSource ? loadInputForDetail() : loadLastTripInput()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailRecordId, isStoredSource, planId])
  const [selectedPlan, setSelectedPlan] = useState(initialSelectedPlan)
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
  const [isEditing, setIsEditing] = useState(false)
  const [isRecomputingRoutes, setIsRecomputingRoutes] = useState(false)
  const [candidates, setCandidates] = useState<VerifiedPlaceCandidate[]>([])
  const [replacingStopId, setReplacingStopId] = useState<string | null>(null)

  const detailStateKey = planId
    ? getPlanDetailStateKey(planId, detailSource, detailRecordId)
    : ''
  const detailState = detailStateKey ? planDetailStates[detailStateKey] : undefined
  const detailCompletionStatus: 'idle' | 'loading' | 'error' =
    detailState?.status === 'loading'
      ? 'loading'
      : detailState?.status === 'error'
        ? 'error'
        : 'idle'
  const detailCompletionError = detailState?.error ?? ''
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

  // ... rest of useMemos ...

  async function handleDeleteStop(stopId: string) {
    if (!selectedPlan) return

    const stopName = baseStops.find((s, i) => getStopId(s, i) === stopId)?.name

    if (
      !(await dialog.confirm({
        title: '刪除景點',
        message: `確定要刪除「${stopName}」嗎？刪除後將重新計算交通時間與總時長。`,
        confirmLabel: '確認刪除',
      }))
    ) {
      return
    }

    setIsEditing(true)
    try {
      const nextStops = baseStops.filter((s, i) => getStopId(s, i) !== stopId)
      const { transportSegments: nextSegments, totalTime } = await recomputeTripRoutes(
        nextStops,
        activeTransportMode,
      )

      const updatedPlan: TripPlan = {
        ...selectedPlan,
        totalTime,
        [isRainMode ? 'rainBackup' : 'stops']: nextStops,
        [isRainMode ? 'rainTransportSegments' : 'transportSegments']: nextSegments,
      }

      setSelectedPlan(updatedPlan)
      persistSelectedPlanLocally(updatedPlan)
      await persistPlanUpdate(selectedPlan, updatedPlan)
      
      // Clear order overrides if any
      setStopOrders((current) => ({ ...current, [orderMode]: [] }))
    } catch (error) {
      void dialog.alert({
        title: '刪除失敗',
        message: error instanceof Error ? error.message : '刪除景點時發生錯誤。',
      })
    } finally {
      setIsEditing(false)
    }
  }

  async function handleOpenReplaceMenu(stopId: string) {
    if (!selectedPlan) return

    if (replacingStopId === stopId) {
      setReplacingStopId(null)
      return
    }

    setReplacingStopId(stopId)
    
    if (candidates.length === 0) {
      setIsEditing(true)
      try {
        const pool = await getReplacementCandidates(lastInput)
        setCandidates(pool.allCandidates || [])
      } catch (error) {
        void dialog.alert({
          title: '取得候選失敗',
          message: error instanceof Error ? error.message : '無法取得替換景點。',
        })
      } finally {
        setIsEditing(false)
      }
    }
  }

  async function handleReplaceStop(stopId: string, candidate: VerifiedPlaceCandidate) {
    if (!selectedPlan) return

    setIsEditing(true)
    try {
      const nextStops = baseStops.map((s, i) => {
        if (getStopId(s, i) === stopId) {
          return {
            ...s,
            name: candidate.name,
            address: candidate.address,
            placeId: candidate.placeId,
            googleMapsUrl: candidate.googleMapsUrl,
            lat: candidate.lat,
            lng: candidate.lng,
          }
        }
        return s
      })

      const replacedIndex = nextStops.findIndex((stop, index) => getStopId(stop, index) === stopId)
      const nextSegments = buildEstimatedSegmentsAfterReplacement(
        nextStops,
        baseStops,
        rawTransportSegments,
        activeTransportMode,
        replacedIndex,
      )

      const updatedPlan: TripPlan = {
        ...selectedPlan,
        [isRainMode ? 'rainBackup' : 'stops']: nextStops,
        [isRainMode ? 'rainTransportSegments' : 'transportSegments']: nextSegments,
        ...(isRainMode
          ? {}
          : {
              totalTime: getStopsAndSegmentsDuration(nextStops, nextSegments),
            }),
      }

      setSelectedPlan(updatedPlan)
      persistSelectedPlanLocally(updatedPlan)
      await persistPlanUpdate(selectedPlan, updatedPlan)
      setReplacingStopId(null)
    } catch (error) {
      void dialog.alert({
        title: '替換失敗',
        message: error instanceof Error ? error.message : '替換景點時發生錯誤。',
      })
    } finally {
      setIsEditing(false)
    }
  }

  function persistSelectedPlanLocally(updatedPlan: TripPlan) {
    if (isStoredSource) {
      updateDetailPlan(updatedPlan)
    } else {
      updateGeneratedPlan(updatedPlan)
    }
  }

  async function persistPlanUpdate(
    previousPlan: TripPlan,
    updatedPlan: TripPlan,
  ) {
    if (!user) {
      return
    }

    try {
      if (isStoredSource && sourcePage && detailRecordId) {
        await updateStoredTripRecordById(
          sourcePage === 'recent' ? 'recent' : 'favorite',
          detailRecordId,
          updatedPlan,
          lastInput,
          user.id,
        )
        return
      }

      if (isStoredSource) {
        return
      }

      await syncUpdatedTripRecordPlan(previousPlan, updatedPlan, lastInput, user.id)
    } catch (error) {
      console.error('Trip record update failed:', error)
    }
  }

  const baseStops = useMemo(() => {
    if (!selectedPlan) {
      return []
    }

    return (isRainMode ? selectedPlan.rainBackup : selectedPlan.stops) || []
  }, [isRainMode, selectedPlan])

  const rawTransportSegments = useMemo(() => {
    if (!selectedPlan) {
      return []
    }

    return (
      (isRainMode
        ? selectedPlan.rainTransportSegments
        : selectedPlan.transportSegments) || []
    )
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

  const timelineStartTime = selectedPlan?.scheduleStartTime ?? lastInput?.startTime

  const stopRows = useMemo(
    () =>
      buildStopRows(
        visibleStops,
        visibleTransportSegmentsWithOverrides,
        timelineStartTime,
      ),
    [timelineStartTime, visibleStops, visibleTransportSegmentsWithOverrides],
  )

  const visibleDuration =
    visibleStops.reduce((total, stop) => total + stop.duration, 0) +
    visibleTransportSegmentsWithOverrides.reduce(
      (total, segment) => total + segment.duration,
      0,
    )
  const allowedTripMinutes = getAllowedTripMinutes(timelineStartTime, lastInput?.endTime)
  const hasValidRainBackup = useMemo(
    () => Boolean(selectedPlan?.rainBackup && selectedPlan.rainBackup.length >= 2),
    [selectedPlan],
  )
  const canShowRainBackup = Boolean(selectedPlan?.isDetailComplete && hasValidRainBackup)

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [planId])

  useEffect(() => {
    if (isRainMode && !hasValidRainBackup) {
      setIsRainMode(false)
    }
  }, [hasValidRainBackup, isRainMode])

  useEffect(() => {
    const nextStoredDetailPlan = loadPlanForDetail(planId)
    const nextGeneratedPlan = loadGeneratedPlans().find((plan) => plan.id === planId)
    const nextSelectedPlan = isStoredSource ? nextStoredDetailPlan : nextGeneratedPlan

    // Only replace the selectedPlan reference when the meaningful state changes;
    // otherwise the detail-completion useEffect will see a new selectedPlan ref
    // on mount and abort its own fetch before the response arrives.
    setSelectedPlan((prev) => {
      if (!nextSelectedPlan) return nextSelectedPlan
      if (!prev) return nextSelectedPlan
      if (
        prev.id === nextSelectedPlan.id &&
        Boolean(prev.isDetailComplete) === Boolean(nextSelectedPlan.isDetailComplete)
      ) {
        return prev
      }
      return nextSelectedPlan
    })
  }, [isStoredSource, planId])

  // Ensure a detail-completion fetch is running for this plan. The fetch is
  // owned by the AnalysisSession context so it keeps running even if the user
  // leaves this page before it finishes.
  useEffect(() => {
    if (!planId || !selectedPlan || selectedPlan.isDetailComplete) return
    requestPlanDetails(planId, { source: detailSource, recordId: detailRecordId })
  }, [detailRecordId, detailSource, planId, requestPlanDetails, selectedPlan])

  // When the context marks this plan as complete, re-read the upgraded plan
  // from sessionStorage so the current detail view refreshes in-place.
  useEffect(() => {
    if (!planId) return
    if (detailState?.status !== 'complete') return
    if (selectedPlan?.isDetailComplete) return

    const upgradedGenerated = loadGeneratedPlans().find((plan) => plan.id === planId)
    const upgradedStored = loadPlanForDetail(planId)
    const upgraded = isStoredSource ? upgradedStored : upgradedGenerated

    if (upgraded?.isDetailComplete) {
      setSelectedPlan(upgraded)
    }
  }, [detailState?.status, isStoredSource, planId, selectedPlan])

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
    if (!replacingStopId) {
      return
    }

    function closeReplacementMenuOnOutsidePointer(event: PointerEvent) {
      const target = event.target

      if (!(target instanceof Element)) {
        return
      }

      if (target.closest('[data-candidate-menu-root="true"]')) {
        return
      }

      setReplacingStopId(null)
    }

    document.addEventListener('pointerdown', closeReplacementMenuOnOutsidePointer)

    return () => {
      document.removeEventListener('pointerdown', closeReplacementMenuOnOutsidePointer)
    }
  }, [replacingStopId])

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
      visibleTransportSegmentsWithOverrides,
      nextStops,
      visibleStops,
      activeTransportMode,
    )
    const overDoubleSegment = getOverDoubleTransportSegment(
      nextTransportSegments,
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
      [orderMode]: [],
    }))
    setSegmentModeOverrides((current) => ({
      ...current,
      [orderMode]: {},
    }))
    setTransportModeOverrides((current) => {
      const next = { ...current }
      delete next[orderMode]
      return next
    })

    const updatedPlan: TripPlan = {
      ...selectedPlan,
      ...(isRainMode
        ? {
            rainBackup: nextStops,
            rainTransportSegments: nextTransportSegments,
          }
        : {
            stops: nextStops,
            transportSegments: nextTransportSegments,
            transportMode: getFirstSegmentMode(nextTransportSegments) ?? activeTransportMode,
            totalTime: getTotalVisibleDuration(nextStops, nextTransportSegments),
          }),
    }

    setSelectedPlan(updatedPlan)
    persistSelectedPlanLocally(updatedPlan)
    await persistPlanUpdate(selectedPlan, updatedPlan)
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

    if (!selectedPlan.isDetailComplete) {
      void dialog.alert({
        title: '正在補完整細節',
        message: '正在補完整細節，完成後再收藏。',
      })
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

  async function handleRecomputeVisibleRoutes() {
    if (!selectedPlan || visibleStops.length < 2 || isRecomputingRoutes) {
      return
    }

    const confirmed = await dialog.confirm({
      title: '重新計算交通',
      message:
        '這將消耗 2 點點數以取得最新的 Google 導航時間與距離，確定要執行嗎？',
    })

    if (!confirmed) {
      return
    }

    setIsRecomputingRoutes(true)
    setIsEditing(true)
    try {
      await pointsService.consumePoints(2, '交通重算')

      const {
        transportSegments: nextSegments,
        totalTime,
        routesFailed,
      } = await recomputeTripRoutes(
        visibleStops,
        activeTransportMode,
        visibleTransportSegmentsWithOverrides,
      )

      const updatedPlan: TripPlan = {
        ...selectedPlan,
        ...(isRainMode
          ? {
              rainBackup: visibleStops,
              rainTransportSegments: nextSegments,
            }
          : {
              stops: visibleStops,
              transportSegments: nextSegments,
              transportMode: getFirstSegmentMode(nextSegments) ?? activeTransportMode,
              totalTime,
            }),
      }

      setSelectedPlan(updatedPlan)
      persistSelectedPlanLocally(updatedPlan)
      await persistPlanUpdate(selectedPlan, updatedPlan)
      setStopOrders((current) => ({ ...current, [orderMode]: [] }))
      setSegmentModeOverrides((current) => ({ ...current, [orderMode]: {} }))
      setTransportModeOverrides((current) => {
        const next = { ...current }
        delete next[orderMode]
        return next
      })
      setOpenSegmentMenuKey(null)

      if (routesFailed) {
        void dialog.alert({
          title: '部分交通仍為估算',
          message:
            '有些路段暫時沒有取得 Google Routes API 結果，已先保留估算交通時間。',
        })
      }
    } catch (error) {
      void dialog.alert({
        title: '交通重算失敗',
        message:
          error instanceof Error
            ? error.message
            : '目前無法重新計算交通時間，請稍後再試。',
      })
    } finally {
      setIsRecomputingRoutes(false)
      setIsEditing(false)
    }
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
            <button
              className="transport-switch-button"
              type="button"
              disabled={isRecomputingRoutes || visibleStops.length < 2}
              onClick={() => void handleRecomputeVisibleRoutes()}
            >
              {isRecomputingRoutes ? '重算中' : '重算交通'}
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

      {!selectedPlan.isDetailComplete || isEditing ? (
        <div className={`detail-completion-panel${isEditing ? ' is-editing' : ''}`} role="status" aria-live="polite">
          {detailCompletionStatus === 'error' && !isEditing ? (
            <>
              <h2>細節補充失敗</h2>
              <p>{detailCompletionError || '細節補充失敗，請稍後再試。'}</p>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  if (planId) {
                    requestPlanDetails(planId, {
                      source: detailSource,
                      recordId: detailRecordId,
                    })
                  }
                }}
              >
                細節補充失敗，重新補充
              </button>
            </>
          ) : (
            <>
              <div className="detail-completion-heading">
                <span
                  className="detail-completion-spinner"
                  aria-hidden="true"
                />
                <h2>{isEditing ? '正在重新計算交通與時程' : '正在補完整細節'}</h2>
              </div>
              <p>
                {isEditing 
                  ? '正在根據地點變動重算最佳路線與預估時間，請稍候。' 
                  : '先看路線骨架，景點介紹、雨天備案與交通摘要正在補上。'}
              </p>
              <div
                className="detail-completion-progress"
                role="presentation"
                aria-hidden="true"
              >
                <span className="detail-completion-progress-bar" />
              </div>
            </>
          )}
        </div>
      ) : null}

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
          const mapsUrl = getVerifiedMapsUrl(stop)
          const directionsUrl = getVerifiedDirectionsUrl(stop, activeTransportMode)

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
                    {stop.description ||
                      (selectedPlan.isDetailComplete
                        ? '這個景點暫時沒有補充說明。'
                        : '正在補完整細節，AI 會為這個景點補上具體簡介。')}
                  </p>

                  <dl className="stop-details">
                    <div>
                      <dt>地址</dt>
                      <dd>{stop.address}</dd>
                    </div>
                  </dl>

                  <div className="stop-actions">
                    {mapsUrl ? (
                      <a
                        className="maps-link"
                        href={mapsUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        開啟 Google Maps
                      </a>
                    ) : (
                      <span className="maps-link maps-link-disabled">地點未驗證</span>
                    )}
                    {directionsUrl ? (
                      <a
                        className="maps-link"
                        href={directionsUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        開始導航
                      </a>
                    ) : (
                      <span className="maps-link maps-link-disabled">無法導航</span>
                    )}
                    
                    <div
                      className="stop-edit-actions"
                      data-candidate-menu-root={
                        replacingStopId === getStopId(stop, index) ? 'true' : undefined
                      }
                    >
                      <button
                        className="maps-link stop-edit-button"
                        type="button"
                        disabled={isEditing}
                        onClick={() => void handleOpenReplaceMenu(getStopId(stop, index))}
                      >
                        換一站
                      </button>
                      <button
                        className="maps-link stop-edit-button stop-delete-button"
                        type="button"
                        disabled={isEditing || visibleStops.length <= 2}
                        onClick={() => void handleDeleteStop(getStopId(stop, index))}
                      >
                        刪除行程
                      </button>
                      
                      {replacingStopId === getStopId(stop, index) ? (
                        <CandidateReplacementMenu
                          candidates={candidates}
                          stopType={stop.type}
                          usedPlaceIds={new Set(baseStops.map(s => s.placeId).filter(Boolean) as string[])}
                          onSelect={(candidate) => void handleReplaceStop(getStopId(stop, index), candidate)}
                          onClose={() => setReplacingStopId(null)}
                        />
                      ) : null}
                    </div>
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
            disabled={isRainMode ? false : !canShowRainBackup}
          >
            {isRainMode
              ? '查看一般行程'
              : selectedPlan.isDetailComplete
                ? hasValidRainBackup
                  ? '切換雨天備案'
                  : '無符合雨備'
                : '補完後可看雨備'}
          </button>
        </div>

        <div className="favorite-action-panel action-strip">
          <button
            className="submit-button"
            type="button"
            onClick={() => void handleSaveFavorite()}
            disabled={hasSavedFavorite || isSavingFavorite}
          >
            {hasSavedFavorite
              ? '已收藏'
              : selectedPlan.isDetailComplete
                ? '收藏此方案'
                : '補完細節後可收藏'}
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
  const baseMainStops = Array.isArray(plan.stops) ? plan.stops : []
  const baseMainSegments = Array.isArray(plan.transportSegments)
    ? plan.transportSegments
    : []
  const baseRainStops = Array.isArray(plan.rainBackup) ? plan.rainBackup : []
  const baseRainSegments = Array.isArray(plan.rainTransportSegments)
    ? plan.rainTransportSegments
    : []
  const mainStops = applyStopOrder(baseMainStops, stopOrders.main)
  const mainSegments = applySegmentModeOverrides(
    getGloballyAppliedTransportSegments(
      getTransportSegments(baseMainSegments, mainStops, baseMainStops, mainMode),
      mainMode,
      transportModeOverrides.main,
    ),
    segmentModeOverrides.main,
  )

  const rainMode = transportModeOverrides.rain ?? plan.transportMode
  const rainStops = applyStopOrder(baseRainStops, stopOrders.rain)
  const rainSegments = applySegmentModeOverrides(
    getGloballyAppliedTransportSegments(
      getTransportSegments(
        baseRainSegments,
        rainStops,
        baseRainStops,
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

function CandidateReplacementMenu({
  candidates,
  stopType,
  usedPlaceIds,
  onSelect,
  onClose,
}: {
  candidates: VerifiedPlaceCandidate[]
  stopType: StopType
  usedPlaceIds: Set<string>
  onSelect: (candidate: VerifiedPlaceCandidate) => void
  onClose: () => void
}) {
  const filtered = useMemo(() => {
    // 同類型優先，避開已使用的 placeId
    const typedCandidates = candidates.filter((c) => {
      if (usedPlaceIds.has(c.placeId)) return false
      
      const types = c.types ?? []
      if (stopType === 'food') {
        return types.some((t: string) => ['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'food'].includes(t))
      }
      return !types.some((t: string) => ['restaurant', 'cafe', 'bakery', 'meal_takeaway'].includes(t))
    })

    return typedCandidates.length > 0 ? typedCandidates.slice(0, 5) : candidates.filter(c => !usedPlaceIds.has(c.placeId)).slice(0, 5)
  }, [candidates, stopType, usedPlaceIds])

  return (
    <div className="candidate-menu" role="dialog" aria-label="選擇替換景點">
      <div className="candidate-menu-header">
        <p>選擇替換地點</p>
        <button type="button" onClick={onClose}>×</button>
      </div>
      <div className="candidate-list">
        {filtered.length === 0 ? (
          <p className="candidate-empty">暫無合適的替代地點</p>
        ) : (
          filtered.map((candidate) => (
            <button
              key={candidate.placeId}
              className="candidate-item"
              type="button"
              onClick={() => onSelect(candidate)}
            >
              <strong>{candidate.name}</strong>
              <span>{candidate.address}</span>
              {candidate.rating ? <small>⭐ {candidate.rating}</small> : null}
            </button>
          ))
        )}
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
    const overrideMode =
      overrides[getSegmentKey(segment)] ?? overrides[getReverseSegmentKey(segment)]

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
    label: buildTransportFallbackLabel(nextMode, publicTransitType, true),
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

function buildEstimatedSegmentsAfterReplacement(
  nextStops: Stop[],
  originalStops: Stop[],
  rawSegments: unknown,
  fallbackMode: TransportMode,
  replacedIndex: number,
) {
  const nextSegments = getTransportSegments(rawSegments, nextStops, originalStops, fallbackMode)

  return nextSegments.map((segment, index) => {
    const touchesReplacedStop = index === replacedIndex - 1 || index === replacedIndex
    return touchesReplacedStop ? markEstimatedSegment(segment) : segment
  })
}

function getStopsAndSegmentsDuration(stops: Stop[], segments: TransportSegment[]) {
  return (
    stops.reduce((total, stop) => total + stop.duration, 0) +
    segments.reduce((total, segment) => total + segment.duration, 0)
  )
}

function getBaseTransportSegments(
  segments: unknown,
  stops: Stop[] | undefined,
  fallbackMode: TransportMode,
) {
  const safeStops = stops || []
  if (Array.isArray(segments) && segments.length === Math.max(safeStops.length - 1, 0)) {
    const normalizedSegments = segments.map((segment, index) =>
      normalizeTransportSegment(segment, safeStops, fallbackMode, index),
    )

    if (normalizedSegments.every(isTransportSegmentValue)) {
      return normalizedSegments
    }
  }

  return safeStops.slice(0, -1).map((stop, index) => ({
    fromStopId: getStopId(stop, index),
    toStopId: getStopId(safeStops[index + 1], index + 1),
    mode: fallbackMode,
    duration: estimateLegacyTransportDuration(stop.transport),
    label: buildTransportFallbackLabel(fallbackMode, undefined, true),
  }))
}

function buildTransportSegmentsForOrder(
  orderedStops: Stop[],
  originalStops: Stop[],
  baseSegments: TransportSegment[],
  fallbackMode: TransportMode,
) {
  const safeOrderedStops = orderedStops || []
  const safeOriginalStops = originalStops || []
  const safeBaseSegments = baseSegments || []

  const averageDuration =
    Math.round(
      safeBaseSegments.reduce((total, segment) => total + segment.duration, 0) /
        Math.max(safeBaseSegments.length, 1),
    ) || 20
  const originalIndexById = new Map(
    safeOriginalStops.map((stop, index) => [getStopId(stop, index), index]),
  )

  return safeOrderedStops.slice(0, -1).map((stop, index) => {
    const fromStopId = getStopId(stop, index)
    const toStopId = getStopId(safeOrderedStops[index + 1], index + 1)
    const slotSegment = safeBaseSegments[index]
    const existingSegment = findReusableTransportSegment(
      safeBaseSegments,
      fromStopId,
      toStopId,
    )

    if (
      existingSegment?.direction === 'exact' &&
      slotSegment?.fromStopId === fromStopId &&
      slotSegment?.toStopId === toStopId
    ) {
      return {
        ...existingSegment.segment,
        fromStopId,
        toStopId,
      }
    }

    if (slotSegment) {
      return markEstimatedSegment({
        ...slotSegment,
        fromStopId,
        toStopId,
        duration: estimateReorderedTransportDuration(
          fromStopId,
          toStopId,
          originalIndexById,
          safeBaseSegments,
          slotSegment.duration || averageDuration,
        ),
      })
    }

    if (existingSegment?.direction === 'reverse') {
      return markEstimatedSegment({
        ...existingSegment.segment,
        fromStopId,
        toStopId,
      })
    }

    const estimatedDuration = estimateReorderedTransportDuration(
      fromStopId,
      toStopId,
      originalIndexById,
      safeBaseSegments,
      averageDuration,
    )

    return {
      fromStopId,
      toStopId,
      mode: fallbackMode,
      duration: estimatedDuration,
      label: buildTransportFallbackLabel(fallbackMode, undefined, true),
    }
  })
}

function findReusableTransportSegment(
  segments: TransportSegment[],
  fromStopId: string,
  toStopId: string,
) {
  const exactSegment = segments.find(
    (segment) => segment.fromStopId === fromStopId && segment.toStopId === toStopId,
  )

  if (exactSegment) {
    return { segment: exactSegment, direction: 'exact' as const }
  }

  const reverseSegment = segments.find(
    (segment) => segment.fromStopId === toStopId && segment.toStopId === fromStopId,
  )

  if (reverseSegment) {
    return { segment: reverseSegment, direction: 'reverse' as const }
  }

  return null
}

function markEstimatedSegment(segment: TransportSegment): TransportSegment {
  if (segment.label.includes('估算')) {
    return segment
  }

  return {
    ...segment,
    label: buildTransportFallbackLabel(segment.mode, segment.publicTransitType, true),
  }
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

function getReverseSegmentKey(segment: TransportSegment) {
  return `${segment.toStopId}->${segment.fromStopId}`
}

function buildDirectionsUrl(stop: Stop, mode: TransportMode) {
  const destination = encodeURIComponent(stop.address || stop.name)
  const travelMode =
    mode === 'public_transit' ? 'transit' : mode === 'scooter' ? 'two-wheeler' : 'driving'
  const placeParam = stop.placeId ? `&destination_place_id=${stop.placeId}` : ''

  return `https://www.google.com/maps/dir/?api=1&destination=${destination}${placeParam}&travelmode=${travelMode}&dir_action=navigate`
}

function getVerifiedMapsUrl(stop: Stop) {
  if (stop.googleMapsUrl && !stop.googleMapsUrl.includes('/maps/search/')) {
    return stop.googleMapsUrl
  }

  if (stop.placeId) {
    return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(stop.placeId)}`
  }

  return null
}

function getVerifiedDirectionsUrl(stop: Stop, mode: TransportMode) {
  if (!stop.placeId) {
    return null
  }

  return buildDirectionsUrl(stop, mode)
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
  isEstimated = false,
) {
  const prefix = isEstimated ? '(估算)' : ''

  if (mode === 'public_transit' && publicTransitType) {
    return `${prefix}${publicTransitLabels[publicTransitType]}接駁前往`
  }

  if (mode === 'public_transit') {
    return `${prefix}大眾運輸前往`
  }

  if (mode === 'scooter') {
    return `${prefix}騎車順路前往`
  }

  return `${prefix}開車順路前往`
}

function cleanTransportSummary(
  value: string,
  mode: TransportMode,
  publicTransitType?: PublicTransitType,
) {
  const trimmed = value.trim()

  if (/約\s*\d+(?:\.\d+)?\s*(?:m|km|公尺|公里)/i.test(trimmed)) {
    return trimmed.replace(/\s+/g, ' ')
  }

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

function getDetailSource(value: unknown, search = ''): 'favorites' | 'recent' | null {
  if (isRecord(value) && (value.from === 'favorites' || value.from === 'recent')) {
    return value.from
  }

  const source = new URLSearchParams(search).get('source')
  return source === 'favorites' || source === 'recent' ? source : null
}

function getDetailRecordId(value: unknown, search = ''): string | null {
  if (isRecord(value) && typeof value.recordId === 'string') {
    return value.recordId
  }

  return new URLSearchParams(search).get('recordId')
}

function getPlanDetailStateKey(
  planId: string,
  source: PlanDetailSource,
  recordId?: string | null,
) {
  return source === 'generated'
    ? `generated:${planId}`
    : `${source}:${recordId ?? planId}`
}

function isTransportSegmentValue(
  value: TransportSegment | null,
): value is TransportSegment {
  return value !== null
}
