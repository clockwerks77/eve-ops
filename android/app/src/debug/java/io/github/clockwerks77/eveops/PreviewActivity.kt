package io.github.clockwerks77.eveops

import android.app.Activity
import android.appwidget.AppWidgetHostView
import android.appwidget.AppWidgetManager
import android.content.pm.ActivityInfo
import android.os.Bundle
import android.util.Log
import android.util.SizeF
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView

/**
 * Test builds only: the three widgets on one screen at a size passed in dp, so they can be photographed.
 * They are drawn through AppWidgetHostView, the class launchers use, from the same per-size versions a
 * home screen receives, so the choice of lines and text size is made the way it is on a phone.
 * Extras: "width" and "height" in dp (width 0 = as wide as the screen allows), "landscape".
 */
class PreviewActivity : Activity() {
    private fun dp(n: Float): Int = (n * resources.displayMetrics.density).toInt()

    private fun asLauncher(kind: Kind, size: SizeF): View? = try {
        val info = AppWidgetManager.getInstance(this).getInstalledProvidersForPackage(packageName, null)
            .first { it.provider.className == kind.provider.name }
        val host = AppWidgetHostView(this)
        host.setAppWidget(0, info)
        host.setPadding(0, 0, 0, 0)
        // the size on show plus two it is not, as a home screen would list several
        host.updateAppWidget(Widgets.views(this, kind, listOf(SizeF(140f, 70f), size, SizeF(size.width + 300f, size.height + 300f))))
        host
    } catch (e: Throwable) {
        Log.w("EveOps", "Preview could not draw " + kind + " the way a launcher does", e)
        null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent.getBooleanExtra("landscape", false)) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        val metrics = resources.displayMetrics
        val room = metrics.widthPixels / metrics.density - 32f
        val asked = intent.getIntExtra("width", 0).toFloat()
        val size = SizeF(if (asked > 0f) minOf(asked, room) else room, intent.getIntExtra("height", 200).toFloat())

        val column = LinearLayout(this)
        column.orientation = LinearLayout.VERTICAL
        column.setBackgroundColor(0xFF33434D.toInt())
        column.setPadding(dp(16f), dp(if (size.height > 320f) 40f else 56f), dp(16f), dp(24f))
        for (kind in Kind.values()) {
            val frame = FrameLayout(this)
            val view = asLauncher(kind, size) ?: Widgets.views(this, kind, listOf(size)).apply(applicationContext, frame)
            frame.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            val params = LinearLayout.LayoutParams(dp(size.width), dp(size.height))
            params.bottomMargin = dp(14f)
            column.addView(frame, params)
        }
        val scroll = ScrollView(this)
        scroll.addView(column)
        setContentView(scroll)
    }
}
