package io.github.clockwerks77.eveops

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.format.DateFormat
import android.text.style.ForegroundColorSpan
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import java.time.ZoneId

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

    /**
     * A widget's views for every height: one version per number of lines, each tagged with the height it needs.
     * The launcher shows the fullest one that fits, so a line is either whole or absent, never cut in half.
     */
    fun views(ctx: Context, kind: Kind): RemoteViews {
        val face = face(ctx, kind)
        val scale = ctx.resources.configuration.fontScale
        val bySize = LinkedHashMap<SizeF, RemoteViews>()
        for (n in 1..Fit.MAX_LINES) bySize[SizeF(120f, Fit.needed(n, scale))] = build(ctx, kind, face, n)
        return RemoteViews(bySize)
    }

    /** The version of a widget with exactly this many lines. */
    fun single(ctx: Context, kind: Kind, lines: Int): RemoteViews = build(ctx, kind, face(ctx, kind), lines)

    private fun build(ctx: Context, kind: Kind, face: Face, lines: Int): RemoteViews {
        val v = RemoteViews(ctx.packageName, kind.layout)
        v.setTextViewText(R.id.title, face.title)
        v.setTextViewText(R.id.as_of, if (Snapshots.refreshing(ctx)) "refreshing" else face.asOf)
        v.setTextViewText(R.id.big, face.big)
        v.setTextViewText(R.id.big_note, face.bigNote)
        for (i in LINES.indices) {
            val line = if (i < lines) face.lines.getOrNull(i) else null
            if (line == null) {
                v.setViewVisibility(LINES[i], View.GONE)
            } else {
                v.setViewVisibility(LINES[i], View.VISIBLE)
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
            val ids = manager.getAppWidgetIds(ComponentName(ctx, kind.provider))
            if (ids.isNotEmpty()) manager.updateAppWidget(ids, views(ctx, kind))
        }
    }
}

abstract class EveWidget(private val kind: Kind) : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        manager.updateAppWidget(ids, Widgets.views(context, kind))
        Refresh.schedule(context)
        val signedIn = Auth.session(context, Config.TRADER) != null
        if (signedIn && System.currentTimeMillis() - Snapshots.savedAt(context) > Widgets.STALE_MS) Refresh.now(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        manager.updateAppWidget(id, Widgets.views(context, kind))
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
