package com.vntg.hts

import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * 위젯 설정(⚙) — 서버 주소·Access 서비스 토큰·띄울 관심종목 그룹.
 * 그룹 목록은 서버(/api/summary/groups)에서 받아 채운다 — 서버의 관심종목 그룹 그대로.
 */
class ConfigActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_config)

        val baseUrl = findViewById<EditText>(R.id.baseUrl)
        val cfId = findViewById<EditText>(R.id.cfId)
        val cfSecret = findViewById<EditText>(R.id.cfSecret)
        val spinner = findViewById<Spinner>(R.id.groupSpinner)
        val status = findViewById<TextView>(R.id.status)

        baseUrl.setText(Prefs.baseUrl(this))
        cfId.setText(Prefs.cfId(this))
        cfSecret.setText(Prefs.cfSecret(this))

        var groups = listOf("(전체)")
        fun fillSpinner() {
            spinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, groups)
            val saved = Prefs.group(this)
            val idx = groups.indexOf(saved)
            if (idx >= 0) spinner.setSelection(idx)
        }
        fillSpinner()

        // 그룹 목록 받아오기 — 실패해도 (전체)로 저장할 수 있다
        lifecycleScope.launch {
            try {
                val fetched = Api.fetchGroups(this@ConfigActivity)
                if (fetched.isNotEmpty()) {
                    groups = listOf("(전체)") + fetched
                    fillSpinner()
                    status.text = "그룹 ${fetched.size}개"
                }
            } catch (e: Exception) {
                status.text = "그룹 목록을 못 받았습니다 — 주소·토큰 확인 (${e.message})"
            }
        }

        findViewById<Button>(R.id.save).setOnClickListener {
            val g = spinner.selectedItem?.toString() ?: ""
            Prefs.save(
                this,
                baseUrl = baseUrl.text.toString(),
                cfId = cfId.text.toString(),
                cfSecret = cfSecret.text.toString(),
                group = if (g == "(전체)") "" else g,
            )
            RefreshWorker.schedule(this)
            RefreshWorker.runOnce(this)
            status.text = "저장했습니다 — 위젯이 곧 갱신됩니다"
        }
    }
}
