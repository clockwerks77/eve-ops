package io.github.clockwerks77.eveops

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The list of rings the dashboard's Expedition tab hands over, and what a snooze does to it. */
class TimersTest {
    private val t0 = 1_795_000_000_000L
    private val min = 60_000L

    private val list = """[
        {"id":"tp:${t0 + 45 * min}","group":"tp","at":${t0 + 45 * min},"title":"Picket: Finch takes over","text":"Rook comes off picket, Finch goes on.",
         "late":{"at":${t0 + 50 * min},"title":"Picket change not confirmed","text":"Finch should have relieved Rook 5 minutes ago."},"actions":["done","snooze"]},
        {"id":"tg","group":"tg","at":${t0 + 15 * min},"title":"Sleepers imminent: Barren Perimeter Reservoir","text":"15 minutes since first entry.","late":null,"actions":["done"]},
        {"id":"tp:${t0 + 90 * min}","group":"tp","at":${t0 + 90 * min},"title":"Picket: Wick takes over","text":"Finch comes off picket, Wick goes on.",
         "late":{"at":${t0 + 95 * min},"title":"Picket change not confirmed","text":"Wick should have relieved Finch 5 minutes ago."},"actions":["done","snooze"]},
        {"id":"te:60","group":"te","at":${t0 + 180 * min},"title":"Hole to the C3 static: 60 minutes left at most","text":"It can close at any time.","actions":["done"]}
    ]"""

    @Test
    fun readsThePagesList() {
        val alerts = Timers.parse(JSONArray(list))
        assertEquals(listOf("tp:${t0 + 45 * min}", "tg", "tp:${t0 + 90 * min}", "te:60"), alerts.map { it.id })
        assertEquals("Picket: Finch takes over", alerts[0].title)
        assertEquals(t0 + 50 * min, alerts[0].late!!.at)
        assertEquals(listOf("done", "snooze"), alerts[0].actions)
        assertNull(alerts[1].late)
        assertNull(alerts[3].late)
        // written out and read back, nothing changes: this is how the list survives a restart of the phone
        assertEquals(alerts, Timers.parse(Timers.json(alerts)))
        // entries the app cannot ring for are passed over
        assertTrue(Timers.parse(JSONArray("""[{"id":"","at":5,"title":"x"},{"id":"a","at":0,"title":"x"},{"id":"b","at":9},7,{"id":"c","at":9,"title":"x","late":{"at":3,"title":"y"}}]""")).let { it.size == 1 && it[0].late == null && it[0].group == "c" })
        assertTrue(Timers.parse(null).isEmpty())
    }

    @Test
    fun aSnoozeMovesTheRestOfThatTimerWithIt() {
        val alerts = Timers.parse(JSONArray(list))
        // pressed two minutes after the change at 45 was due: it rings again at 57, and the change after it moves from 90 to 102
        val moved = Timers.snoozed(alerts, "tp:${t0 + 45 * min}", t0 + 47 * min, Timers.SNOOZE_MS)
        assertEquals(t0 + 57 * min, moved[0].at)
        assertEquals(t0 + 62 * min, moved[0].late!!.at)
        assertEquals(t0 + 102 * min, moved[2].at)
        assertEquals(t0 + 107 * min, moved[2].late!!.at)
        // the gas site and the hole are other timers: they stay where they were, and the names do not change
        assertEquals(alerts[1], moved[1])
        assertEquals(alerts[3], moved[3])
        assertEquals(alerts.map { it.id }, moved.map { it.id })
        // a snooze on the later change leaves the earlier one alone
        val later = Timers.snoozed(alerts, "tp:${t0 + 90 * min}", t0 + 90 * min, Timers.SNOOZE_MS)
        assertEquals(alerts[0], later[0])
        assertEquals(t0 + 100 * min, later[2].at)
        // a press for a ring that is no longer listed changes nothing
        assertEquals(alerts, Timers.snoozed(alerts, "gone", t0, Timers.SNOOZE_MS))
    }
}
