package com.directive.terminal;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

/** Renders the currently active directive in an Android home-screen widget. */
public class DirectiveWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) updateWidget(context, manager, widgetId);
    }

    /** Requests an immediate refresh for every widget owned by this application. */
    public static void updateAllWidgets(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, DirectiveWidgetProvider.class);
        int[] widgetIds = manager.getAppWidgetIds(component);
        for (int widgetId : widgetIds) updateWidget(context, manager, widgetId);
    }

    /** Applies the latest native preference values to one widget instance. */
    private static void updateWidget(Context context, AppWidgetManager manager, int widgetId) {
        SharedPreferences preferences = context.getSharedPreferences(
            DirectiveWidgetPlugin.PREFERENCES_NAME,
            Context.MODE_PRIVATE
        );
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.directive_widget);
        views.setTextViewText(R.id.widgetRecipient, "[" + preferences.getString("recipient", "사용자") + "에게]");
        views.setTextViewText(R.id.widgetTrigger, preferences.getString("trigger", "현재 활성 지령이 없습니다."));
        views.setTextViewText(R.id.widgetAction, preferences.getString("action", "앱을 열어 다음 지령을 발행하세요."));

        Intent launchIntent = new Intent(context, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widgetRoot, pendingIntent);
        manager.updateAppWidget(widgetId, views);
    }
}
