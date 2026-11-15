package io.github.clockwerks77.eveops

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView

/** Test builds only: the three widgets, drawn the way a launcher draws them, at a height passed in dp. */
class PreviewActivity : Activity() {
    private fun dp(n: Int): Int = (n * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val column = LinearLayout(this)
        column.orientation = LinearLayout.VERTICAL
        column.setBackgroundColor(0xFF33434D.toInt())
        column.setPadding(dp(16), dp(56), dp(16), dp(24))
        val height = intent.getIntExtra("height", 190)
        for (kind in Kind.values()) {
            val frame = FrameLayout(this)
            frame.addView(Widgets.views(this, kind).apply(applicationContext, frame))
            val params = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(height))
            params.bottomMargin = dp(14)
            column.addView(frame, params)
        }
        val scroll = ScrollView(this)
        scroll.addView(column)
        setContentView(scroll)
    }
}
