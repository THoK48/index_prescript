package com.directive.terminal;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.util.Log;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Supplies the 42 stable date cells required by launcher-compatible calendar collection widgets. */
public class CalendarWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        return new CalendarGridFactory(getApplicationContext(), widgetId);
    }

    /** Rebuilds one widget's date cells whenever its month or mirrored task counts change. */
    private static final class CalendarGridFactory implements RemoteViewsFactory {
        private final Context context;
        private final int widgetId;
        private final SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        private final List<Calendar> days = new ArrayList<>();
        private Map<String, Integer> counts = new HashMap<>();
        private int shownMonth;
        private String todayKey;

        CalendarGridFactory(Context context, int widgetId) {
            this.context = context;
            this.widgetId = widgetId;
        }

        @Override
        public void onCreate() {
            reload();
        }

        @Override
        public void onDataSetChanged() {
            reload();
        }

        @Override
        public void onDestroy() {
            days.clear();
            counts.clear();
        }

        @Override
        public int getCount() {
            return days.size();
        }

        /** Renders one fixed-height cell and attaches only a validated local date to its click. */
        @Override
        public RemoteViews getViewAt(int position) {
            if (position < 0 || position >= days.size()) return null;
            Calendar day = days.get(position);
            String dateKey = dateFormat.format(day.getTime());
            int count = counts.containsKey(dateKey) ? counts.get(dateKey) : 0;
            boolean isToday = todayKey.equals(dateKey);
            boolean inMonth = day.get(Calendar.MONTH) == shownMonth;
            RemoteViews cell = new RemoteViews(context.getPackageName(), R.layout.calendar_widget_grid_day);
            cell.setTextViewText(R.id.calendarDayNumber, String.valueOf(day.get(Calendar.DAY_OF_MONTH)));
            cell.setTextViewText(R.id.calendarDayCount, count > 0 ? (count > 99 ? "99+" : String.valueOf(count)) : "");
            cell.setTextColor(R.id.calendarDayNumber, Color.parseColor(isToday ? "#02080D" : inMonth ? "#5CD0FF" : "#31536A"));
            cell.setTextColor(R.id.calendarDayCount, Color.parseColor(isToday ? "#072233" : "#2FBFFC"));
            cell.setInt(R.id.calendarDayRoot, "setBackgroundResource", isToday ? R.drawable.calendar_widget_today : R.drawable.calendar_widget_day);
            cell.setContentDescription(R.id.calendarDayRoot, dateKey + ", 미완료 할 일 " + count + "개. 할 일 등록");
            cell.setOnClickFillInIntent(R.id.calendarDayRoot, new Intent().putExtra("dateKey", dateKey));
            return cell;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int position) {
            return position < 0 || position >= days.size() ? position : days.get(position).getTimeInMillis();
        }

        @Override
        public boolean hasStableIds() {
            return true;
        }

        /** Reads the selected month and count-only cache without accessing browser localStorage. */
        private void reload() {
            SharedPreferences preferences = CalendarWidgetProvider.getPreferences(context);
            counts = readCounts(preferences);
            Calendar today = Calendar.getInstance();
            todayKey = dateFormat.format(today.getTime());
            Calendar month = (Calendar) today.clone();
            month.set(Calendar.DAY_OF_MONTH, 1);
            month.add(Calendar.MONTH, preferences.getInt("monthOffset" + widgetId, 0));
            shownMonth = month.get(Calendar.MONTH);
            Calendar day = (Calendar) month.clone();
            day.add(Calendar.DAY_OF_MONTH, -(day.get(Calendar.DAY_OF_WEEK) - Calendar.SUNDAY));
            days.clear();
            for (int index = 0; index < 42; index++) {
                days.add((Calendar) day.clone());
                day.add(Calendar.DAY_OF_MONTH, 1);
            }
        }

        /** Ignores malformed native render caches and waits for the next app synchronization. */
        private Map<String, Integer> readCounts(SharedPreferences preferences) {
            Map<String, Integer> result = new HashMap<>();
            try {
                JSONArray savedDays = new JSONArray(preferences.getString("days", "[]"));
                for (int index = 0; index < savedDays.length(); index++) {
                    JSONObject savedDay = savedDays.optJSONObject(index);
                    if (savedDay == null) continue;
                    String dateKey = savedDay.optString("dateKey", "");
                    int count = savedDay.optInt("count", 0);
                    if (dateKey.matches("\\d{4}-\\d{2}-\\d{2}") && count > 0) result.put(dateKey, count);
                }
            } catch (JSONException error) {
                Log.w("CalendarWidget", "Calendar render cache is invalid; reopen the app to refresh it.");
            }
            return result;
        }
    }
}
