TOKEN = "56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33"
SCHOOL_URL = f"https://urniki.easistent.com/urniki/{TOKEN}/razredi/748283"
SCHOOL_ROOT = f"https://urniki.easistent.com/urniki/{TOKEN}"
ROOM_ONE_URL = f"https://urniki.easistent.com/urniki/{TOKEN}/ucilnice/1333027"
ROOM_TWO_URL = f"https://urniki.easistent.com/urniki/{TOKEN}/ucilnice/1333035"
CLASS_AJAX_URL = f"https://urniki.easistent.com/urniki/ajax_urnik/{TOKEN}/815595/0/0/0/12/0/1"
ROOM_ONE_AJAX_URL = f"https://urniki.easistent.com/urniki/ajax_urnik/{TOKEN}/0/0/0/9101/12/0/1"
ROOM_TWO_AJAX_URL = f"https://urniki.easistent.com/urniki/ajax_urnik/{TOKEN}/0/0/0/9102/12/0/1"

CLASS_PAGE = f"""<!doctype html><html><body>
  <div class="urnik_title">Gimnazija Kranj</div>
  <script>const timetableUrl = "{CLASS_AJAX_URL}";</script>
  <a href="{ROOM_ONE_URL}">Učilnice</a>
  <table><tbody><tr>
    <th id="urnik-ura-1"><span class="potek-ure">7:10 - 7:55</span></th>
    <td id="ednevnik-seznam_ur_teden-td-1-2026-11-17"></td>
  </tr></tbody></table>
</body></html>"""

ROOM_INDEX_PAGE = f"""<!doctype html><html><body>
  <div class="urnik_title">Gimnazija Kranj</div>
  <script>const timetableUrl = "{ROOM_ONE_AJAX_URL}";</script>
  <select id="id_parameter">
    <option value="1333027">1</option>
    <option value="1333035">11</option>
  </select>
  <table><tbody><tr>
    <th id="urnik-ura-1"><span class="potek-ure">7:10 - 7:55</span></th>
    <td id="ednevnik-seznam_ur_teden-td-1-2026-11-17"></td>
  </tr></tbody></table>
</body></html>"""

ROOM_FREE_PAGE = """<!doctype html><html><body><table><tbody><tr>
  <th id="urnik-ura-1"><span class="potek-ure">7:10 - 7:55</span></th>
  <td id="ednevnik-seznam_ur_teden-td-1-2026-11-17"></td>
</tr></tbody></table></body></html>"""

ROOM_CANCELLED_PAGE = f"""<!doctype html><html><body>
  <script>const timetableUrl = "{ROOM_TWO_AJAX_URL}";</script>
  <table><tbody><tr>
  <th id="urnik-ura-1"><span class="potek-ure">7:10 - 7:55</span></th>
  <td id="ednevnik-seznam_ur_teden-td-1-2026-11-17">
    <div class="ednevnik-seznam_ur_teden-blok-wrap ednevnik-seznam_ur_teden-td-odpadla-ura">
      <span class="wl-tag-xs" title="Odpadla ura">ODP</span>
    </div>
  </td>
</tr></tbody></table></body></html>"""


def page_for_date(value: str, occupied: bool = False) -> str:
    block = '<div class="ednevnik-seznam_ur_teden-blok-wrap"><span>MAT</span></div>' if occupied else ""
    return f"""<!doctype html><html><body><table><tbody><tr>
      <th id="urnik-ura-1"><span class="potek-ure">7:10 - 7:55</span></th>
      <td id="ednevnik-seznam_ur_teden-td-1-{value}">{block}</td>
    </tr></tbody></table></body></html>"""
