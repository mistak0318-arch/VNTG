package com.vntg.hts

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider

/**
 * 바탕화면 위젯 — 증권플러스 모양의 세로 목록.
 *
 * 한 줄 = 종목명·현재가·대비·등락률·거래량 다섯 칸. **크기 조절이 핵심**이다:
 * 좁아지면 줄 수만 줄이는 게 아니라 **칸도 줄인다** — 거래량부터 빼고, 더 좁으면
 * 대비를 빼서 셋만 남긴다. 다섯 칸을 우겨넣으면 글자가 뭉갠다 (TODO G절 스펙).
 *
 * 데이터는 RefreshWorker 가 15분마다 받아 캐시한 JSON — 여기서는 네트워크를 안 부른다.
 */
class VntgWidget : GlanceAppWidget() {

    /** 크기 구간 셋 — 이 구간이 바뀔 때 recompose 된다 */
    override val sizeMode = SizeMode.Responsive(
        setOf(
            DpSize(110.dp, 110.dp), // 좁게 — 3칸
            DpSize(220.dp, 180.dp), // 중간 — 4칸
            DpSize(300.dp, 300.dp), // 크게 — 5칸
        ),
    )

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val data = Api.parse(Prefs.cachedJson(context))
        provideContent { Content(data) }
    }

    companion object {
        val BG = Color(0xFF171C24)
        val TEXT = Color(0xFFE7EBF0)
        val MUTED = Color(0xFF8B96A5)
        val UP = Color(0xFFF04452) // 한국식 — 오르면 빨강
        val DOWN = Color(0xFF3182F6)
    }
}

@Composable
private fun Content(data: Api.WidgetData) {
    val size = LocalSize.current
    // 칸 줄이기 — 폭 구간마다 어느 칸까지 그릴지
    val showChange = size.width >= 220.dp
    val showVolume = size.width >= 300.dp

    Column(
        modifier = GlanceModifier.fillMaxSize().background(VntgWidget.BG).padding(8.dp),
    ) {
        Header(data)
        if (data.error != null) {
            Text(
                data.error,
                style = TextStyle(color = ColorProvider(VntgWidget.MUTED), fontSize = 12.sp),
                modifier = GlanceModifier.padding(top = 8.dp),
            )
        } else {
            LazyColumn(modifier = GlanceModifier.fillMaxWidth()) {
                items(data.rows) { row -> StockLine(row, showChange, showVolume) }
            }
        }
    }
}

@Composable
private fun Header(data: Api.WidgetData) {
    // 기준시각은 HH:MM 만 — 위젯에 초까지 있을 이유가 없다
    val hhmm = data.at.takeIf { it.length >= 16 }?.let {
        try {
            val d = java.time.OffsetDateTime.parse(it).plusHours(9)
            "%02d:%02d".format(d.hour, d.minute)
        } catch (e: Exception) {
            ""
        }
    } ?: ""
    Row(
        modifier = GlanceModifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            data.group.ifEmpty { "VNTG" },
            style = TextStyle(
                color = ColorProvider(VntgWidget.TEXT),
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
            ),
        )
        Spacer(GlanceModifier.width(6.dp))
        Text(
            listOf(hhmm, data.venue).filter { it.isNotEmpty() }.joinToString(" · "),
            style = TextStyle(color = ColorProvider(VntgWidget.MUTED), fontSize = 10.sp),
            modifier = GlanceModifier.defaultWeight(),
        )
        Text(
            " ↻ ",
            style = TextStyle(color = ColorProvider(VntgWidget.MUTED), fontSize = 14.sp),
            modifier = GlanceModifier.clickable(actionRunCallback<RefreshAction>()),
        )
        Text(
            " ⚙ ",
            style = TextStyle(color = ColorProvider(VntgWidget.MUTED), fontSize = 14.sp),
            modifier = GlanceModifier.clickable(actionStartActivity<ConfigActivity>()),
        )
    }
}

@Composable
private fun StockLine(row: Api.WidgetRow, showChange: Boolean, showVolume: Boolean) {
    val color = when {
        row.changeRate > 0 -> VntgWidget.UP
        row.changeRate < 0 -> VntgWidget.DOWN
        else -> VntgWidget.MUTED
    }
    val fmt = java.text.NumberFormat.getIntegerInstance(java.util.Locale.KOREA)
    Row(
        modifier = GlanceModifier.fillMaxWidth().padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            row.name,
            style = TextStyle(color = ColorProvider(VntgWidget.TEXT), fontSize = 12.sp),
            maxLines = 1,
            modifier = GlanceModifier.defaultWeight(),
        )
        Text(
            fmt.format(row.price),
            style = TextStyle(
                color = ColorProvider(VntgWidget.TEXT),
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
            ),
        )
        if (showChange) {
            Spacer(GlanceModifier.width(6.dp))
            Text(
                (if (row.change > 0) "▲" else if (row.change < 0) "▼" else "") +
                    fmt.format(kotlin.math.abs(row.change)),
                style = TextStyle(color = ColorProvider(color), fontSize = 11.sp),
            )
        }
        Spacer(GlanceModifier.width(6.dp))
        Text(
            String.format(java.util.Locale.US, "%+.2f%%", row.changeRate),
            style = TextStyle(color = ColorProvider(color), fontSize = 11.sp),
        )
        if (showVolume) {
            Spacer(GlanceModifier.width(6.dp))
            Text(
                fmt.format(row.volume),
                style = TextStyle(color = ColorProvider(VntgWidget.MUTED), fontSize = 10.sp),
            )
        }
    }
}

/** ↻ — 지금 한 번 받아서 다시 그린다 */
class RefreshAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        RefreshWorker.runOnce(context)
    }
}

class VntgWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = VntgWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        // 위젯이 처음 놓일 때 주기 갱신을 건다
        RefreshWorker.schedule(context)
        RefreshWorker.runOnce(context)
    }
}
