package io.github.clockwerks77.eveops

import android.app.Activity
import android.appwidget.AppWidgetHostView
import android.appwidget.AppWidgetManager
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView

/**
 * Test builds only: the three widgets on one screen, each at a height passed in dp, so they can be photographed.
 * They are drawn through AppWidgetHostView, the class launchers use, so the choice of how many lines to show
 * is made the same way it is on a home screen.
 */
class PreviewActivity : Activity() {
    private fun dp(n: Int): Int = (n * resources.displayMetrics.density).toInt()

    private fun asLauncher(kind: Kind): View? = try {
        val info = AppWidgetManager.getInstance(this).getInstalledProvidersForPackage(packageName, null)
            .first { it.provider.className == kind.provider.name }
        val host = AppWidgetHostView(this)
        host.setAppWidget(0, info)
        host.setPadding(0, 0, 0, 0)
        host.updateAppWidget(Widgets.views(this, kind))
        host
    } catch (e: Throwable) {
        Log.w("EveOps", "Preview could not draw " + kind + " the way a launcher does", e)
        null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val column = LinearLayout(this)
        column.orientation = LinearLayout.VERTICAL
        column.setBackgroundColor(0xFF33434D.toInt())
        column.setPadding(dp(16), dp(56), dp(16), dp(24))
        val height = intent.getIntExtra("height", 190)
        for (kind in Kind.values()) {
            val frame = FrameLayout(this)
            val view = asLauncher(kind) ?: Widgets.single(this, kind, Fit.linesFor(height.toFloat(), resources.configuration.fontScale))
                .apply(applicationContext, frame)
            frame.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            val params = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(height))
            params.bottomMargin = dp(14)
            column.addView(frame, params)
        }
        val scroll = ScrollView(this)
        scroll.addView(column)
        setContentView(scroll)
    }
}
