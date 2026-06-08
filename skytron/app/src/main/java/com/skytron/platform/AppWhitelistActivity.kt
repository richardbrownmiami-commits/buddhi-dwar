package com.skytron.platform
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
class AppWhitelistActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val list = ListView(this).apply { layoutParams = android.view.ViewGroup.LayoutParams(-1, -1) }
        list.choiceMode = ListView.CHOICE_MODE_MULTIPLE
        setContentView(list)
        title = "Choose Allowed Apps"
        val prefs = getSharedPreferences("skytron", MODE_PRIVATE)
        val allowed = prefs.getString("allowed_apps", "")?.split(",")?.filter { it.isNotBlank() }?.toSet() ?: emptySet()
        val pm = packageManager
        val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
            .filter { it.packageName != packageName }
            .sortedBy { pm.getApplicationLabel(it).toString() }
        val names = apps.map { pm.getApplicationLabel(it).toString() }
        val pkgs = apps.map { it.packageName }
        list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_multiple_choice, names)
        for (i in pkgs.indices) { if (pkgs[i] in allowed) list.setItemChecked(i, true) }
        list.setOnItemClickListener { _, _, pos, _ ->
            val set = mutableSetOf<String>()
            for (i in pkgs.indices) { if (list.isItemChecked(i)) set.add(pkgs[i]) }
            prefs.edit().putString("allowed_apps", set.joinToString(",")).apply()
            Toast.makeText(this, "${set.size} apps allowed", Toast.LENGTH_SHORT).show()
        }
    }
}
