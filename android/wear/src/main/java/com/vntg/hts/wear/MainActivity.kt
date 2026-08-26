package com.vntg.hts.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material.Card
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText

/**
 * 워치 앱 — 네이버 증권 워치앱 모양.
 *
 * 목록: 카드마다 티커 · 현재가 · 등락률 배지 · 다른 세션(After/Day) 가격.
 * 상세: 현재가·대비·등락률·다른 세션. 카드를 누르면 들어간다(뒤로 스와이프로 복귀).
 * standalone — 폰 없이 워치 와이파이/LTE 로 서버 요약 하나만 읽는다.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { WatchRoot() }
    }
}

private val UP = Color(0xFFF04452)
private val DOWN = Color(0xFF3182F6)
private val MUTED = Color(0xFF8B96A5)

private fun rateColor(rate: Double): Color = when {
    rate > 0 -> UP
    rate < 0 -> DOWN
    else -> MUTED
}

private fun pct(rate: Double): String = String.format(java.util.Locale.US, "%+.2f%%", rate)

@Composable
private fun WatchRoot() {
    val ctx = LocalContext.current
    var data by remember { mutableStateOf<WatchApi.WatchData?>(null) }
    var detail by remember { mutableStateOf<WatchApi.UsRow?>(null) }
    var reload by remember { mutableStateOf(0) }

    LaunchedEffect(reload) { data = WatchApi.fetch(ctx) }

    MaterialTheme {
        Scaffold(timeText = { TimeText() }) {
            val d = data
            val sel = detail
            when {
                sel != null -> DetailScreen(sel) { detail = null }
                d == null -> Center("불러오는 중...")
                d.error != null -> Center("${d.error}\n(터치해서 재시도)") { reload += 1 }
                else -> ListScreen(d, onSelect = { detail = it }, onReload = { reload += 1 })
            }
        }
    }
}

@Composable
private fun Center(msg: String, onTap: (() -> Unit)? = null) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .let { if (onTap != null) it.clickable { onTap() } else it }
            .padding(20.dp),
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(msg, fontSize = 12.sp, color = MUTED)
    }
}

@Composable
private fun ListScreen(
    d: WatchApi.WatchData,
    onSelect: (WatchApi.UsRow) -> Unit,
    onReload: () -> Unit,
) {
    ScalingLazyColumn(modifier = Modifier.fillMaxSize()) {
        // 지수 한 줄 — 시장부터
        item {
            val idx = d.indices.take(2)
            Text(
                idx.joinToString("  ") { "${it.name} ${pct(it.changeRate)}" } +
                    (d.signalLevel?.let { "  ${signalDot(it)}" } ?: ""),
                fontSize = 10.sp,
                color = MUTED,
                modifier = Modifier.clickable { onReload() },
            )
        }
        // 해외 카드 (네이버 워치 모양)
        items(d.us) { row -> UsCard(row) { onSelect(row) } }
        // 국내 관심 — 아래쪽에 간단히
        items(d.domestic) { row ->
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(row.name, fontSize = 11.sp, modifier = Modifier.weight(1f), maxLines = 1)
                Text(
                    java.text.NumberFormat.getIntegerInstance(java.util.Locale.KOREA).format(row.price),
                    fontSize = 11.sp,
                )
                Text(
                    " " + pct(row.changeRate),
                    fontSize = 10.sp,
                    color = rateColor(row.changeRate),
                )
            }
        }
        item { Text("${d.venue} · 터치로 새로고침", fontSize = 9.sp, color = MUTED, modifier = Modifier.clickable { onReload() }) }
    }
}

private fun signalDot(level: String): String = when (level) {
    "green" -> "🟢"
    "yellow" -> "🟡"
    else -> "🔴"
}

@Composable
private fun UsCard(row: WatchApi.UsRow, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    row.symbol,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                Text(pct(row.changeRate), fontSize = 11.sp, color = rateColor(row.changeRate))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (row.price.isNaN()) "-" else String.format(java.util.Locale.US, "%.2f", row.price),
                    fontSize = 12.sp,
                    modifier = Modifier.weight(1f),
                )
                if (row.sessionLabel != null && row.sessionPrice != null) {
                    Text(
                        "${row.sessionLabel} ${String.format(java.util.Locale.US, "%.2f", row.sessionPrice)}",
                        fontSize = 9.sp,
                        color = MUTED,
                    )
                }
            }
        }
    }
}

@Composable
private fun DetailScreen(row: WatchApi.UsRow, onBack: () -> Unit) {
    ScalingLazyColumn(modifier = Modifier.fillMaxSize().clickable { onBack() }) {
        item { Text("${row.flag} ${row.symbol}", fontSize = 14.sp, fontWeight = FontWeight.Bold) }
        item { Text(row.name, fontSize = 10.sp, color = MUTED, maxLines = 1) }
        item {
            Text(
                if (row.price.isNaN()) "-" else String.format(java.util.Locale.US, "%.2f", row.price),
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
            )
        }
        item { Text(pct(row.changeRate), fontSize = 13.sp, color = rateColor(row.changeRate)) }
        if (row.sessionLabel != null && row.sessionPrice != null) {
            item {
                Text(
                    "${row.sessionLabel} ${String.format(java.util.Locale.US, "%.2f", row.sessionPrice)}" +
                        (row.sessionChangeRate?.let { " ${pct(it)}" } ?: ""),
                    fontSize = 11.sp,
                    color = MUTED,
                )
            }
        }
        item { Text("탭하면 목록으로", fontSize = 9.sp, color = MUTED) }
    }
}
