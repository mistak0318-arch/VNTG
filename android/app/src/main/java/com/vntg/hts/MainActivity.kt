package com.vntg.hts

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

/**
 * 폰 앱 껍데기 — 본체는 웹(PWA)이다. 누르면 브라우저로 HTS 를 연다.
 * 위젯 주기 갱신도 여기서 한 번 걸어 둔다(위젯을 놓기 전에 앱만 깔았을 때 대비).
 */
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        RefreshWorker.schedule(this)
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Prefs.baseUrl(this))))
        finish()
    }
}
