package io.github.clockwerks77.eveops

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/** The widgets' wording, checked against the summary the dashboard page produces from its own sample data. */
class FacesTest {
    private val sample = JSONObject(javaClass.getResourceAsStream("/snapshot-demo.json")!!.bufferedReader().readText())
    private val at = sample.getLong("at")
    private val words = Wording(at, ZoneId.of("America/Toronto"), false)

    private fun text(line: List<Seg>) = line.joinToString("") { it.text }

    @Test
    fun trading() {
        val f = Faces.trading(sample, words)
        assertEquals("Sample Trader (sample data)", f.title)
        assertEquals("as of 4:28 AM", f.asOf)
        assertEquals("9.08B", f.big)
        assertEquals("overall wealth, both", f.bigNote)
        assertEquals(
            listOf(
                "1 to check · 10 to change · 2 your call",
                "Hek 2 (here) · Rens 1 · Dodixie 3 · Jita 4 · Amarr 1",
                "Wallet 6.07B · buy orders 271.3M · on sale 681.6M",
                "Net this week +76.9M · today +1.4M",
                "16 sell orders · 4 buy orders · 20 of 145 slots",
                "Docked in Hek · Prorator",
            ),
            f.lines.map(::text),
        )
        assertEquals(listOf(Tone.BAD, Tone.DIM, Tone.WARN, Tone.DIM, Tone.CALM), f.lines[0].map { it.tone })
    }

    @Test
    fun planets() {
        val f = Faces.planets(sample, words)
        assertEquals("Planetary Interaction (sample data)", f.title)
        assertEquals("66.9M", f.big)
        assertEquals("waiting on the planets", f.bigNote)
        assertEquals(
            listOf(
                "Worth a stop now",
                "7,310 units · 5,483 m³ · +2.2M a day",
                "Alakgur III: extractors stopped 2 h ago",
                "5 colonies stop Tue 6:28 PM (in 3 days)",
                "Eystur · 1 jump from Hek · 1 from you",
                "Fullest storage 11%",
            ),
            f.lines.map(::text),
        )
        assertEquals(Tone.LEAD, f.lines[0][0].tone)
        assertEquals(Tone.BAD, f.lines[2][0].tone)
    }

    @Test
    fun wormholes() {
        val f = Faces.wormholes(sample, words)
        assertEquals("Sample Scout (sample data)", f.title)
        assertEquals("J111613", f.big)
        assertEquals("C3", f.bigNote)
        assertEquals(
            listOf(
                "Docked at J111613 - Sample Fortizar · Stratios “Deep Dive”",
                "Cataclysmic Variable · E175 to C4, 16 h",
                "1 kill here in 24 h · 3 this week · 6 signatures",
                "Loot: list 140.0M or sell now 125.6M · 5,105 m³",
                "Best single hub to list: Hek · in 3 places",
                "Training Archaeology V, done Sat 6:28 AM",
            ),
            f.lines.map(::text),
        )
        assertEquals(Tone.BAD, f.lines[2][0].tone)
    }

    @Test
    fun emptyAccount() {
        val s = JSONObject(
            """{"v":1,"at":$at,"pilot":"New Pilot","wealth":null,"wallet":null,"week":0,"today":0,
               "orders":{"sells":0,"bids":0,"change":0,"optional":0,"check":0,"hold":0,"used":null,"max":null},
               "hubs":[],"pi":null,"planets":[],"scout":null,"wh":null,"problems":0}""",
        )
        val t = Faces.trading(s, words)
        assertEquals("New Pilot", t.title)
        assertEquals("", t.big)
        assertEquals("No open orders", text(t.lines[0]))
        assertTrue(t.lines.none { l -> text(l).contains("null") })
        assertEquals("No colonies", Faces.planets(s, words).big)
        val w = Faces.wormholes(s, words)
        assertEquals("No pilot", w.big)
        assertEquals("Sign in the wormhole pilot on the Wormholes tab.", text(w.lines[0]))
    }

    @Test
    fun pilotSignedInButNoReadingYet() {
        val s = JSONObject("""{"v":1,"at":$at,"pilot":"T","scout":{"name":"Khiana Kyn","wealth":1,"wallet":1,"skill":null,"loot":{"places":0,"value":0,"m3":0,"list":null,"now":null,"hub":""}},"wh":null}""")
        val w = Faces.wormholes(s, words)
        assertEquals("Khiana Kyn", w.title)
        assertEquals(listOf("No location reading yet.", "No loot or gas to hand over"), w.lines.map(::text))
    }

    @Test
    fun notWorthAStopAndFeedsDown() {
        val s = JSONObject(sample.toString())
        s.getJSONObject("pi").put("go", "wait").put("reach", 3)
        s.put("problems", 2)
        assertEquals("Not worth a stop yet · reaches 50.0M in 3 days", text(Faces.planets(s, words).lines[0]))
        assertEquals("2 data feeds did not load", text(Faces.trading(s, words).lines[5]))
        s.getJSONObject("pi").put("reach", -1)
        assertEquals("Not worth a stop yet · under 50.0M all week", text(Faces.planets(s, words).lines[0]))
    }

    @Test
    fun numbersAndTimes() {
        assertEquals("14.83B", words.isk(14_830_000_000.0))
        assertEquals("589.1M", words.isk(589_100_000.0))
        assertEquals("9.1k", words.isk(9_100.0))
        assertEquals("950", words.isk(950.4))
        assertEquals("-3.2M", words.signed(-3_200_000.0))
        assertEquals("+3.2M", words.signed(3_200_000.0))
        assertEquals("under a minute", words.span(20_000))
        assertEquals("40 min", words.span(40 * 60_000L))
        assertEquals("3 h 20 min", words.span(200 * 60_000L))
        assertEquals("12 h", words.span(12 * 3_600_000L + 5 * 60_000L))
        assertEquals("2 days", words.span(50 * 3_600_000L))
        assertEquals("in 40 min", words.until(at + 40 * 60_000L))
        assertEquals("40 min ago", words.until(at - 40 * 60_000L))
        assertEquals("Nov 30", words.clock(at + 15 * 86_400_000L))
        val day = Wording(at, ZoneId.of("America/Toronto"), true)
        assertEquals("04:28", day.clock(at))
        assertEquals("Tue 18:28", day.clock(at + 62 * 3_600_000L))
    }
}
