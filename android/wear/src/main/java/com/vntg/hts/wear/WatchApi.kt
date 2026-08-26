package com.vntg.hts.wear

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 워치 요약 — `/api/summary/watch` 하나만 부른다.
 * 접속 정보는 res/values/config.xml (빌드 전에 적는다 — 워치에서 타이핑은 고문).
 */
object WatchApi {

    /** 국내 관심 한 줄 */
    data class KrRow(val name: String, val price: Long, val changeRate: Double)

    /**
     * 해외 카드 — 네이버 증권 워치앱 모양.
     * session 은 「지금 도는 다른 세션」 — 정규장 중엔 null, 마감 후엔 After, 한국 낮엔 주간거래.
     */
    data class UsRow(
        val symbol: String,
        val name: String,
        val price: Double,
        val changeRate: Double,
        val sessionLabel: String?,
        val sessionPrice: Double?,
        val sessionChangeRate: Double?,
        val flag: String,
    )

    data class IndexRow(val name: String, val price: Double, val changeRate: Double)

    data class WatchData(
        val at: String,
        val venue: String,
        val domestic: List<KrRow>,
        val us: List<UsRow>,
        val indices: List<IndexRow>,
        val signalLevel: String?,
        val error: String? = null,
    )

    suspend fun fetch(ctx: Context): WatchData = withContext(Dispatchers.IO) {
        try {
            val base = ctx.getString(R.string.vntg_base_url).trimEnd('/')
            val conn = URL("$base/api/summary/watch").openConnection() as HttpURLConnection
            try {
                conn.connectTimeout = 10_000
                conn.readTimeout = 10_000
                val id = ctx.getString(R.string.vntg_cf_id)
                val secret = ctx.getString(R.string.vntg_cf_secret)
                if (id.isNotEmpty() && secret.isNotEmpty()) {
                    conn.setRequestProperty("CF-Access-Client-Id", id)
                    conn.setRequestProperty("CF-Access-Client-Secret", secret)
                }
                if (conn.responseCode != 200) error("HTTP ${conn.responseCode}")
                parse(conn.inputStream.bufferedReader().readText())
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            WatchData("", "", emptyList(), emptyList(), emptyList(), null, error = e.message ?: "접속 실패")
        }
    }

    private fun parse(json: String): WatchData {
        val o = JSONObject(json)

        val dom = o.optJSONArray("domestic").let { arr ->
            if (arr == null) emptyList() else (0 until arr.length()).map { i ->
                val r = arr.getJSONObject(i)
                KrRow(r.optString("name"), r.optLong("price"), r.optDouble("changeRate", 0.0))
            }
        }

        val us = o.optJSONArray("us").let { arr ->
            if (arr == null) emptyList() else (0 until arr.length()).map { i ->
                val r = arr.getJSONObject(i)
                /*
                 * 다른 세션 고르기 — 웹 usSession.ts 와 같은 규칙:
                 * 애프터 값이 있으면 After, 주간거래 값이 있으면 Day. 둘 다 없으면 안 띄운다.
                 */
                val after = r.optDouble("afterPrice", Double.NaN)
                val day = r.optDouble("dayPrice", Double.NaN)
                val (label, p, rate) = when {
                    !after.isNaN() && after > 0 ->
                        Triple("After", after, r.optDouble("afterChangeRate", Double.NaN))
                    !day.isNaN() && day > 0 ->
                        Triple("Day", day, r.optDouble("dayChangeRate", Double.NaN))
                    else -> Triple(null, null, null)
                }
                UsRow(
                    symbol = r.optString("symbol"),
                    name = r.optString("name"),
                    price = r.optDouble("price", Double.NaN),
                    changeRate = r.optDouble("changeRate", 0.0),
                    sessionLabel = label,
                    sessionPrice = p,
                    sessionChangeRate = if (rate != null && rate.isNaN()) null else rate,
                    flag = r.optString("flag"),
                )
            }
        }

        val idx = o.optJSONArray("indices").let { arr ->
            if (arr == null) emptyList() else (0 until arr.length()).map { i ->
                val r = arr.getJSONObject(i)
                IndexRow(r.optString("name"), r.optDouble("price", 0.0), r.optDouble("changeRate", 0.0))
            }
        }

        return WatchData(
            at = o.optString("at"),
            venue = o.optString("venue"),
            domestic = dom,
            us = us,
            indices = idx,
            signalLevel = o.optJSONObject("signal")?.optString("level"),
        )
    }
}
