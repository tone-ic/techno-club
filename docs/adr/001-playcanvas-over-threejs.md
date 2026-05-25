# ADR 001 — PlayCanvas вместо Three.js

**Статус**: Принято  
**Дата**: v2.0

## Контекст

Нужен 3D движок для браузера, оптимизированный под iPhone Safari, с поддержкой GLB/GLTF, анимаций, навигации и WebGL.

## Решение

Использовать **PlayCanvas** (open-source версия, `playcanvas` npm пакет).

## Обоснование

| Критерий | PlayCanvas | Three.js |
|----------|------------|----------|
| Сцена/Entity система | Встроена | Нужен самописный |
| Анимации (GLB) | Встроены | AnimationMixer, ручная работа |
| Физика/коллизии | Встроена (Ammo.js) | Нужна отдельная библиотека |
| iPhone производительность | Оптимизирован под mobile | Хорошо, но больше ручной работы |
| Batching/LOD | Встроен | Нужен InstanciedMesh и ручной LOD |
| Навигация (navmesh) | Плагин реcast | Нужна отдельная библиотека |
| Размер бандла | ~670KB gzip | ~580KB gzip |

## Последствия

- Использовать `import * as pc from 'playcanvas'`
- Сцена хранится в PlayCanvas entity hierarchy
- Скрипты — через `pc.ScriptType`
- GLB загрузка через `pc.Asset` и `pc.GltfContainerComponent`
