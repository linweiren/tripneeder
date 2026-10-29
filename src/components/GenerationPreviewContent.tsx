import { readGenerationPreview, type GenerationPreview } from '../services/ai/generationPreview.js'

export function GenerationPreviewContent({ preview }: { preview?: GenerationPreview }) {
  const safe = readGenerationPreview(preview)
  return <div className="analysis-plan-content">
    {safe ? <>
      <h2>{safe.stopCount} 個停留點的初步安排</h2>
      {safe.sampleVenueNames.length > 0 ? <p>已找到的部分景點：{safe.sampleVenueNames.join('・')}</p> : null}
      <p>{safe.highlights.join('・')}</p>
    </> : <p>正在檢查實際站點與交通安排…</p>}
    <p>初步安排仍可能調整；行程完成並成功扣除 20 點後，將顯示完整路線。</p>
  </div>
}
