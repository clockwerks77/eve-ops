package io.github.clockwerks77.eveops

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.format.DateFormat
import android.text.style.ForegroundColorSpan
import android.util.SizeF
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import java.time.ZoneId
import kotlin.math.roundToInt

/** The three home-screen widgets. Each has its own layout file, all with the same views in them. */
enum class Kind(val layout: Int, val view: String, val provider: Class<out AppWidgetProvider>) {
    TRADING(R.layout.widget_trading, "trading", TradingWidget::class.java),
    PLANETS(R.layout.widget_pi, "trading", PlanetsWidget::class.java),
    WORMHOLES(R.layout.widget_wormhole, "wormholes", WormholesWidget::class.java),
}

object Widgets {
    const val ACTION_REFRESH = "io.github.clockwerks77.eveops.REFRESH"

    /** A widget showing figures older than this asks for a refresh when Android next wakes it. */
    const val STALE_MS = 25 * 60_000L

    private val LINES = intArrayOf(R.id.line1, R.id.line2, R.id.line3, R.id.line4, R.id.line5, R.id.line6)

    /** What a widget should say right now. */
    fun face(ctx: Context, kind: Kind): Face {
        val words = Wording(System.currentTimeMillis(), ZoneId.systemDefault(), DateFormat.is24HourFormat(ctx))
        val title = when (kind) {
            Kind.TRADING -> "Trading"
            Kind.PLANETS -> "Planetary Interaction"
            Kind.WORMHOLES -> "Wormholes"
        }
        val signedIn = Auth.session(ctx, Config.TRADER) != null
        val snap = Snapshots.load(ctx)
        if (snap == null) return if (signedIn) Faces.waiting(title) else Faces.signIn(title)
        if (!signedIn && !snap.optBoolean("sample")) return Faces.signIn(title)
        return when (kind) {
            Kind.TRADING -> Faces.trading(snap, words)
            Kind.PLANETS -> Faces.planets(snap, words)
            Kind.WORMHOLES -> Faces.wormholes(snap, words)
        }
    }

    private fun color(ctx: Context, tone: Tone): Int = ctx.getColor(
        when (tone) {
            Tone.INK -> R.color.ink
            Tone.DIM -> R.color.dim
            Tone.LEAD -> R.color.lead
            Tone.WARN -> R.color.warn
            Tone.BAD -> R.color.bad
            Tone.CALM -> R.color.calm
        },
    )

    private fun styled(ctx: Context, line: List<Seg>): CharSequence {
        val out = SpannableStringBuilder()
        for (seg in line) {
            val from = out.length
            out.append(seg.text)
            out.setSpan(ForegroundColorSpan(color(ctx, seg.tone)), from, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return out
    }

    /** Sizes to cover when a launcher does not say how large it shows a widget. At most 16 are allowed. */
    private val DEFAULT_SIZES: List<SizeF> =
        listOf(250f, 330f, 400f, 600f).flatMap { w -> listOf(110f, 150f, 190f, 250f).map { h -> SizeF(w, h) } }

    /** The sizes, in dp, at which the launcher shows this widget: upright and on its side, folded and unfolded. */
    fun sizesOf(manager: AppWidgetManager, id: Int): List<SizeF> {
        val options = manager.getAppWidgetOptions(id) ?: return emptyList()
        val exact: List<SizeF>? = if (Build.VERSION.SDK_INT >= 33) {
            options.getParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES, SizeF::class.java)
        } else {
            @Suppress("DEPRECATION")
            options.getParcelableArrayList<SizeF>(AppWidgetManager.OPTION_APPWIDGET_SIZES)
        }
        if (!exact.isNullOrEmpty()) return exact
        val upright = SizeF(
            options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH).toFloat(),
            options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT).toFloat(),
        )
        val sideways = SizeF(
            options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH).toFloat(),
            options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT).toFloat(),
        )
        return listOf(upright, sideways).filter { it.width > 0f && it.height > 0f }
    }

    /**
     * A widget's views for each size it is shown at. Every size gets its own version: as many whole lines
     * as fit, drawn as large as that size allows. The launcher shows the version made for its current size,
     * so the text follows the widget as it is resized.
     */
    fun views(ctx: Context, kind: Kind, sizes: List<SizeF>): RemoteViews {
        val face = face(ctx, kind)
        val fontScale = ctx.resources.configuration.fontScale
        val wanted = sizes.ifEmpty { DEFAULT_SIZES }.distinct().take(16)
        val bySize = LinkedHashMap<SizeF, RemoteViews>()
        for (size in wanted) {
            bySize[size] = build(ctx, kind, face, Fit.plan(size.width, size.height, face.lines.size, fontScale))
        }
        return if (bySize.size == 1) bySize.values.first() else RemoteViews(bySize)
    }

    private fun build(ctx: Context, kind: Kind, face: Face, plan: Fit.Plan): RemoteViews {
        val v = RemoteViews(ctx.packageName, kind.layout)
        val k = plan.scale
        val dip = TypedValue.COMPLEX_UNIT_DIP
        val density = ctx.resources.displayMetrics.density
        fun px(dp: Float): Int = (dp * density).roundToInt()

        v.setViewLayoutHeight(R.id.head, Fit.HEAD * k, dip)
        v.setViewLayoutWidth(R.id.refresh, 40f * k, dip)
        v.setViewPadding(R.id.refresh, px(9f * k), px(5f * k), px(9f * k), px(5f * k))
        v.setTextViewTextSize(R.id.title, dip, Fit.TITLE * k)
        v.setTextViewTextSize(R.id.as_of, dip, Fit.SMALL * k)
        v.setTextViewTextSize(R.id.big, dip, Fit.BIG * k)
        v.setTextViewTextSize(R.id.big_note, dip, Fit.SMALL * k)

        v.setTextViewText(R.id.title, face.title)
        v.setTextViewText(R.id.as_of, if (Snapshots.refreshing(ctx)) "refreshing" else face.asOf)
        v.setTextViewText(R.id.big, face.big)
        v.setTextViewText(R.id.big_note, face.bigNote)
        for (i in LINES.indices) {
            val line = if (i < plan.lines) face.lines.getOrNull(i) else null
            if (line == null) {
                v.setViewVisibility(LINES[i], View.GONE)
            } else {
                v.setViewVisibility(LINES[i], View.VISIBLE)
                v.setTextViewTextSize(LINES[i], dip, Fit.LINE * k)
                v.setViewLayoutMargin(LINES[i], RemoteViews.MARGIN_TOP, plan.gap, dip)
                v.setTextViewText(LINES[i], styled(ctx, line))
            }
        }
        // A tap opens the matching view of the dashboard; the arrow refreshes without opening anything.
        val open = Intent(Intent.ACTION_VIEW, Uri.parse("eveops://open?view=" + kind.view), ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        v.setOnClickPendingIntent(
            android.R.id.background,
            PendingIntent.getActivity(ctx, kind.ordinal, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
        )
        val refresh = Intent(ctx, kind.provider).setAction(ACTION_REFRESH)
        v.setOnClickPendingIntent(
            R.id.refresh,
            PendingIntent.getBroadcast(ctx, kind.ordinal, refresh, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
        )
        return v
    }

    /** Redraws every widget on the home screen from the stored summary. */
    fun updateAll(ctx: Context) {
        val manager = AppWidgetManager.getInstance(ctx) ?: return
        for (kind in Kind.values()) {
            for (id in manager.getAppWidgetIds(ComponentName(ctx, kind.provider))) {
                manager.updateAppWidget(id, views(ctx, kind, sizesOf(manager, id)))
            }
        }
    }
}

abstract class EveWidget(private val kind: Kind) : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) manager.updateAppWidget(id, Widgets.views(context, kind, Widgets.sizesOf(manager, id)))
        Refresh.schedule(context)
        val signedIn = Auth.session(context, Config.TRADER) != null
        if (signedIn && System.currentTimeMillis() - Snapshots.savedAt(context) > Widgets.STALE_MS) Refresh.now(context)
    }

    /** The widget was resized (or the phone folded, unfolded or turned): draw it again for its new sizes. */
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        manager.updateAppWidget(id, Widgets.views(context, kind, Widgets.sizesOf(manager, id)))
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Widgets.ACTION_REFRESH) {
            if (Auth.session(context, Config.TRADER) != null) {
                Snapshots.refreshing(context, true)
                Refresh.now(context)
            }
            Widgets.updateAll(context)
        } else {
            super.onReceive(context, intent)
        }
    }
}

class TradingWidget : EveWidget(Kind.TRADING)

class PlanetsWidget : EveWidget(Kind.PLANETS)

class WormholesWidget : EveWidget(Kind.WORMHOLES)
