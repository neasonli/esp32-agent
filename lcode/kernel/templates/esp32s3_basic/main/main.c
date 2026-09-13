/*
 * ESP32-S3 FreeRTOS 固件模板
 * 本文件为占位模板：Agent 代码生成节点会按用户需求覆盖 main/main.c。
 * 结构约定：app_main 入口 + xTaskCreate 创建业务任务（FreeRTOS，ESP-IDF 内建）。
 */
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"

static const char *TAG = "app";

static void sensor_task(void *pvParameters)
{
    (void)pvParameters;
    while (1) {
        ESP_LOGI(TAG, "sensor task running");
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

static void uart_task(void *pvParameters)
{
    (void)pvParameters;
    while (1) {
        ESP_LOGI(TAG, "uart task running");
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "app start");
    xTaskCreate(sensor_task, "sensor", 4096, NULL, 5, NULL);
    xTaskCreate(uart_task, "uart", 4096, NULL, 5, NULL);
}
