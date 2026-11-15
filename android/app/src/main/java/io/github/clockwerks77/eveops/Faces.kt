package io.github.clockwerks77.eveops

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToLong

/*
 * What each widget says, worked out from the summary the dashboard page hands over.
 * No Android classes in this file, so all of it is tested on a plain JVM.
 */

enum class Tone { INK, DIM, LEAD, WARN, BAD, CALM }

data class Seg(val text: String, val tone: Tone = Tone.INK)

/** One widget's text: a title row, one large figure with a note beside it, and up to six lines. */
data class Face(
    val title: String,
    val asOf: String,
    val big: String,
    val bigNote: String,
    val lines: List<List<Seg>>,
)

/** Numbers and times as the dashboard writes them. */
class Wording(
    private val now: Long,
    private val zone: ZoneId,
    private val use24: Boolean,
    private val locale: Locale = Locale.US,
) {
    fun isk(n: Double): String {
        val a = abs(n)
        return when {
            a >= 1e9 -> String.format(locale, "%.2fB", n / 1e9)
            a >= 1e6 -> String.format(locale, "%.1fM", n / 1e6)
            a >= 1e3 -> String.format(locale, "%.1fk", n / 1e3)
            else -> n.roundToLong().toString()
        }
    }

    fun signed(n: Double): String = (if (n > 0) "+" else "") + isk(n)

    fun count(n: Long): String = String.format(locale, "%,d", n)

    /** A time of day today, a weekday and time within the week, otherwise a date. */
    fun clock(ms: Long): String {
        val t = Instant.ofEpochMilli(ms).atZone(zone)
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(today, t.toLocalDate())
        val time = if (use24) "HH:mm" else "h:mm a"
        val pattern = when {
            days == 0L -> time
            abs(days) < 7 -> "EEE $time"
            else -> "MMM d"
        }
        return DateTimeFormatter.ofPattern(pattern, locale).format(t)
    }

    /** A length of time in words: "40 min", "3 h 20 min", "2 days". */
    fun span(ms: Long): String {
        val m = abs(ms) / 60000
        val h = m / 60
        return when {
            m < 1 -> "under a minute"
            m < 60 -> "$m min"
            h < 48 -> if (h < 10 && m % 60 > 0) "$h h ${m % 60} min" else "$h h"
            else -> "${(h / 24.0).roundToLong()} days"
        }
    }

    fun until(ms: Long): String = if (ms >= now) "in " + span(ms - now) else span(now - ms) + " ago"

    fun asOf(ms: Long): String = if (ms > 0) "as of " + clock(ms) else ""

    fun isPast(ms: Long): Boolean = ms < now

    fun within(ms: Long, window: Long): Boolean = ms - now < window
}

/**
 * How much of a widget fits at a given height. Heights are in dp; text grows with the user's font size.
 * Measured on a Pixel 6 emulator: 4dp top padding, a 30dp title row, the large figure, then lines of 14sp text
 * 3dp apart, and 10dp at the bottom.
 */
object Fit {
    const val MAX_LINES = 6

    fun needed(lines: Int, fontScale: Float): Float = 44f + 30.5f * fontScale + lines * (19.4f * fontScale + 3f)

    fun linesFor(heightDp: Float, fontScale: Float): Int =
        (1..MAX_LINES).lastOrNull { needed(it, fontScale) <= heightDp } ?: 1
}

object Faces {
    private val ROMAN = listOf("", "I", "II", "III", "IV", "V")
    private const val HOUR = 3_600_000L

    private fun JSONObject.obj(key: String): JSONObject? = if (isNull(key)) null else optJSONObject(key)
    private fun JSONObject.arr(key: String): JSONArray? = if (isNull(key)) null else optJSONArray(key)
    private fun JSONObject.text(key: String): String = if (isNull(key)) "" else optString(key, "")
    private fun JSONObject.num(key: String): Double? = if (isNull(key)) null else optDouble(key).takeIf { !it.isNaN() }
    private fun JSONObject.whole(key: String): Long = num(key)?.roundToLong() ?: 0L
    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }

    private fun line(text: String, tone: Tone = Tone.INK): List<Seg> = listOf(Seg(text, tone))
    private fun dots(parts: List<String>): String = parts.filter { it.isNotEmpty() }.joinToString(" · ")
    private fun plural(n: Long, one: String, many: String = one + "s"): String = "$n " + if (n == 1L) one else many

    /** Nobody is signed in on this device. */
    fun signIn(title: String): Face =
        Face(title, "", "Sign in", "", listOf(line("Open Eve Ops and log in with EVE.", Tone.DIM)))

    /** Signed in, but the page has not handed over a summary yet. */
    fun waiting(title: String): Face =
        Face(title, "", "Loading", "", listOf(line("The first refresh is on its way.", Tone.DIM)))

    private fun titled(s: JSONObject, name: String): String = if (s.optBoolean("sample")) "$name (sample data)" else name

    // ---------------------------------------------------------------- trading
    fun trading(s: JSONObject, w: Wording): Face {
        val o = s.obj("orders") ?: JSONObject()
        val check = o.whole("check")
        val change = o.whole("change")
        val optional = o.whole("optional")
        val sells = o.whole("sells")
        val bids = o.whole("bids")

        val calls = mutableListOf<Seg>()
        fun call(text: String, tone: Tone) {
            if (calls.isNotEmpty()) calls += Seg(" · ", Tone.DIM)
            calls += Seg(text, tone)
        }
        if (check > 0) call("$check to check", Tone.BAD)
        if (change > 0) call("$change to change", Tone.WARN)
        if (optional > 0) call("$optional your call", Tone.CALM)
        if (calls.isEmpty()) call(if (sells + bids > 0) "Nothing to change" else "No open orders", Tone.LEAD)

        // where the work is, nearest hub first (the page sends them in that order)
        val busy = (s.arr("hubs")?.objects() ?: emptyList()).mapNotNull { h ->
            val n = h.whole("change") + h.whole("check")
            if (n <= 0) null else h.text("name") + " " + n + if (h.optBoolean("here")) " (here)" else ""
        }
        val where = dots(listOf(s.text("where"), s.text("ship")))

        val lines = mutableListOf<List<Seg>>(calls)
        if (busy.isNotEmpty()) lines += line(busy.joinToString(" · "))
        lines += line(
            dots(
                listOf(
                    s.num("wallet")?.let { "Wallet " + w.isk(it) } ?: "",
                    s.num("escrow")?.let { "buy orders " + w.isk(it) } ?: "",
                    s.num("listed")?.let { "on sale " + w.isk(it) } ?: "",
                ),
            ),
        )
        lines += line(
            dots(
                listOf(
                    s.num("week")?.let { "Net this week " + w.signed(it) } ?: "",
                    s.num("today")?.let { "today " + w.signed(it) } ?: "",
                ),
            ),
            Tone.DIM,
        )
        val slots = if (o.isNull("max")) "" else o.whole("used").toString() + " of " + o.whole("max") + " slots"
        lines += line(dots(listOf(plural(sells, "sell order"), plural(bids, "buy order"), slots)), Tone.DIM)
        val problems = s.whole("problems")
        if (problems > 0) lines += line(plural(problems, "data feed") + " did not load", Tone.BAD)
        else if (where.isNotEmpty()) lines += line(where, Tone.DIM)

        val wealth = s.num("wealth")
        return Face(
            title = titled(s, s.text("pilot").ifEmpty { "Trading" }),
            asOf = w.asOf(s.whole("at")),
            big = wealth?.let { w.isk(it) } ?: "",
            bigNote = if (wealth == null) "" else if (s.optBoolean("both")) "overall wealth, both" else "overall wealth",
            lines = lines.filter { l -> l.any { it.text.isNotEmpty() } }.take(6),
        )
    }

    // ---------------------------------------------------------------- planets
    fun planets(s: JSONObject, w: Wording): Face {
        val title = titled(s, "Planetary Interaction")
        val asOf = w.asOf(s.whole("at"))
        val all = s.arr("planets")?.objects() ?: emptyList()
        if (all.isEmpty()) return Face(title, asOf, "No colonies", "", listOf(line("Nothing is set up on any planet.", Tone.DIM)))

        val lines = mutableListOf<List<Seg>>()
        val pi = s.obj("pi")
        if (pi != null) {
            val worth = pi.num("worth") ?: 0.0
            val reach = pi.whole("reach")
            lines += when (pi.text("go")) {
                "full" -> line("Pick up now: storage is nearly full", Tone.WARN)
                "worth" -> line("Worth a stop now", Tone.LEAD)
                else -> listOf(
                    Seg("Not worth a stop yet", Tone.INK),
                    Seg(
                        when {
                            reach == 1L -> " · reaches " + w.isk(worth) + " tomorrow"
                            reach > 1L -> " · reaches " + w.isk(worth) + " in $reach days"
                            else -> " · under " + w.isk(worth) + " all week"
                        },
                        Tone.DIM,
                    ),
                )
            }
            lines += line(
                dots(
                    listOf(
                        w.count(pi.whole("units")) + " units",
                        w.count(pi.whole("m3")) + " m³",
                        pi.num("perDay")?.let { w.signed(it) + " a day" } ?: "",
                    ),
                ),
            )
        }

        // extractor timers: what has stopped, what stops next
        val timed = all.filter { !it.isNull("expiry") && it.whole("expiry") > 0 }
        val stopped = timed.filter { w.isPast(it.whole("expiry")) }
        val running = timed.filter { !w.isPast(it.whole("expiry")) }.sortedBy { it.whole("expiry") }
        if (stopped.size == 1) {
            lines += line(stopped[0].text("name") + ": extractors stopped " + w.until(stopped[0].whole("expiry")), Tone.BAD)
        } else if (stopped.size > 1) {
            lines += line(stopped.size.toString() + " colonies have stopped extractors", Tone.BAD)
        }
        if (running.isNotEmpty()) {
            val next = running[0].whole("expiry")
            val together = running.filter { it.whole("expiry") - next < 10 * 60000L }
            val who = if (together.size == 1) together[0].text("name") + " stops" else together.size.toString() + " colonies stop"
            lines += line(who + " " + w.clock(next) + " (" + w.until(next) + ")", if (w.within(next, 6 * HOUR)) Tone.WARN else Tone.INK)
            val last = running.last().whole("expiry")
            if (running.size > together.size) lines += line("The last one stops " + w.clock(last), Tone.DIM)
        } else if (stopped.isEmpty()) {
            lines += line("No extractors are running", Tone.DIM)
        }

        if (pi != null) {
            val near = pi.text("near")
            val place = dots(
                listOf(
                    pi.text("system"),
                    if (near.isEmpty() || pi.isNull("nearJumps")) "" else plural(pi.whole("nearJumps"), "jump") + " from " + near,
                    if (pi.isNull("from")) "" else pi.whole("from").toString() + " from you",
                ),
            )
            if (place.isNotEmpty()) lines += line(place, Tone.DIM)
            pi.num("full")?.let { lines += line("Fullest storage " + (it * 100).roundToLong() + "%", Tone.DIM) }
        }

        val value = pi?.num("value")
        return Face(title, asOf, value?.let { w.isk(it) } ?: all.size.toString(), if (value != null) "waiting on the planets" else "colonies", lines.take(6))
    }

    // -------------------------------------------------------------- wormholes
    fun wormholes(s: JSONObject, w: Wording): Face {
        val wh = s.obj("wh")
        val scout = s.obj("scout")
        if (wh == null && scout == null) {
            return Face(titled(s, "Wormholes"), "", "No pilot", "", listOf(line("Sign in the wormhole pilot on the Wormholes tab.", Tone.DIM)))
        }
        val pilot = (wh?.text("pilot") ?: "").ifEmpty { scout?.text("name") ?: "" }.ifEmpty { "Wormholes" }
        val lines = mutableListOf<List<Seg>>()

        if (wh != null) {
            val place = wh.text("place")
            val ship = wh.text("ship")
            val shipName = wh.text("shipName")
            lines += line(
                dots(
                    listOf(
                        if (wh.optBoolean("docked")) "Docked" + (if (place.isEmpty()) "" else " at $place") else "In space",
                        if (ship.isEmpty()) "" else ship + if (shipName.isEmpty()) "" else " “$shipName”",
                    ),
                ),
            )
            val statics = (wh.arr("statics")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList())
            lines += line(dots(listOf(wh.text("effect").ifEmpty { "No effect" }) + statics))
            val sigs = wh.whole("sigs")
            val sigText = if (sigs > 0) " · " + plural(sigs, "signature") else ""
            val kills = wh.obj("kills")
            lines += when {
                kills == null -> line("Kills not loaded yet$sigText", Tone.DIM)
                kills.whole("day") > 0 -> listOf(
                    Seg(plural(kills.whole("day"), "kill") + " here in 24 h", Tone.BAD),
                    Seg(" · " + kills.whole("week") + " this week" + sigText, Tone.DIM),
                )
                else -> line("No kills in 24 h · " + kills.whole("week") + " this week" + sigText, Tone.DIM)
            }
        } else {
            lines += line("No location reading yet.", Tone.DIM)
        }

        val loot = scout?.obj("loot")
        if (loot != null) {
            if (loot.whole("places") <= 0) {
                lines += line("No loot or gas to hand over", Tone.DIM)
            } else {
                val list = loot.num("list")
                val now = loot.num("now")
                val volume = w.count(loot.whole("m3")) + " m³"
                lines += if (list != null && now != null) {
                    line("Loot: list " + w.isk(list) + " or sell now " + w.isk(now) + " · " + volume)
                } else {
                    line("Loot: about " + w.isk(loot.num("value") ?: 0.0) + " · " + volume)
                }
                val hub = loot.text("hub")
                lines += line(
                    dots(listOf(if (hub.isEmpty()) "" else "Best single hub to list: $hub", "in " + plural(loot.whole("places"), "place"))),
                    Tone.DIM,
                )
            }
        }
        val skill = scout?.obj("skill")
        if (skill != null) {
            val level = ROMAN.getOrElse(skill.whole("level").toInt()) { "" }
            lines += line("Training " + skill.text("name") + " " + level + ", done " + w.clock(skill.whole("done")), Tone.DIM)
        }

        return Face(
            title = titled(s, pilot),
            asOf = w.asOf(wh?.whole("at")?.takeIf { it > 0 } ?: s.whole("at")),
            big = wh?.text("system") ?: "",
            bigNote = wh?.text("cls") ?: "",
            lines = lines.take(6),
        )
    }
}
