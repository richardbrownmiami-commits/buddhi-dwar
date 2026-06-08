plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("kotlin-kapt")
    id("androidx.room")
}
android {
    namespace = "com.skytron.platform"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.skytron.platform"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        create("release") {
            storeFile = rootProject.file(System.getenv("KEYSTORE_PATH") ?: "release.keystore")
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: "skytron123"
            keyAlias = System.getenv("KEY_ALIAS") ?: "skytron"
            keyPassword = System.getenv("KEY_PASSWORD") ?: "skytron123"
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { viewBinding = true }
}
room { schemaDirectory("$projectDir/schemas") }
dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.activity:activity-ktx:1.8.2")
    implementation("androidx.fragment:fragment-ktx:1.6.2")
    // Room
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    kapt("androidx.room:room-compiler:2.6.1")

    // ML Kit (only text recognition — bundled, no Play Services required)
    implementation("com.google.mlkit:text-recognition:16.0.0")

    // OkHttp + Gson
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.10.1")

    // Jsoup
    implementation("org.jsoup:jsoup:1.17.2")

    // Glide
    implementation("com.github.bumptech.glide:glide:4.16.0")

    // WorkManager
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Coil (for thumbnails)
    implementation("io.coil-kt:coil:2.6.0")
}
