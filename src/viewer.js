import {
  AnimationMixer, Box3, DirectionalLight, GridHelper, Group, HemisphereLight, LoadingManager,
  LoopOnce, LoopRepeat, MathUtils, PerspectiveCamera, Scene, SkeletonHelper, Sphere, Vector3, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const PLAY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space'])
const JUMP_SECONDS = 0.65
const PLAY_RADIUS = 1

function locomotionClips(clips) {
  const walk = clips.find(clip => /walk|march|trot/i.test(clip.name))
  const run = clips.find(clip => /run|sprint|gallop/i.test(clip.name))
  if (!walk && !run) return undefined
  return {
    idle: clips.find(clip => /idle|stand|survey|breath/i.test(clip.name)),
    walk: walk ?? run,
    run,
    jump: clips.find(clip => /jump|leap/i.test(clip.name)),
  }
}

function validateGlb(bytes) {
  const view = new DataView(bytes)
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== view.byteLength ||
      view.getUint32(16, true) !== 0x4e4f534a || view.getUint32(12, true) > view.byteLength - 20) {
    throw new Error('Expected a complete GLB 2.0 model.')
  }

  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, view.getUint32(12, true))))
  for (const source of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (source.uri !== undefined && (typeof source.uri !== 'string' || !/^data:/i.test(source.uri))) {
      throw new Error('This GLB references external resources.')
    }
  }
}

function releaseScenes(scenes) {
  const geometries = new Set()
  const materials = new Set()
  const textures = new Set()
  const skeletons = new Set()
  const images = new Set()
  for (const scene of scenes) {
    scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry)
      if (object.skeleton) skeletons.add(object.skeleton)
      if (object.material) {
        for (const material of [object.material].flat()) materials.add(material)
      }
    })
  }
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value?.isTexture) textures.add(value)
    }
    material.dispose()
  }
  for (const texture of textures) {
    if (texture.source.data?.close) images.add(texture.source.data)
    texture.dispose()
  }
  for (const image of images) image.close()
  for (const geometry of geometries) geometry.dispose()
  for (const skeleton of skeletons) skeleton.dispose()
}

export function createGlbViewer(host, { onPlaybackChange, onPlayModeChange } = {}) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2))
  const canvas = renderer.domElement
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' })
  const label = host.getAttribute('aria-label')
  if (label) canvas.setAttribute('aria-label', label)
  host.append(canvas)

  const scene = new Scene()
  scene.add(new HemisphereLight(0xffffff, 0x8b91a1, 2))
  const light = new DirectionalLight(0xffffff, 3)
  light.position.set(3, 5, 4)
  scene.add(light)

  const camera = new PerspectiveCamera(42, 1, 0.01, 1000)
  const controls = new OrbitControls(camera, canvas)
  // Orbit changes settle immediately so a snapshot always describes the rendered view.
  controls.enableDamping = false
  const manager = new LoadingManager()
  manager.setURLModifier(url => {
    // The loader creates blob URLs for images stored in GLB buffer views.
    if (/^(data|blob):/i.test(url)) return url
    throw new Error('This GLB references external resources.')
  })
  const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder)
  const direction = new Vector3(3, 2, 4).normalize()
  let model
  let bounds
  let comparisonBounds
  let frame
  let disposed = false
  let revision = 0
  let wireframe = false
  let skeletonHelper
  let mixer
  let clips = []
  let action
  let playing = false
  let loop = true
  let lastFrameTime
  let locomotion
  let play

  function render() {
    if (disposed || frame !== undefined) return
    frame = requestAnimationFrame(time => {
      frame = undefined
      if (playing || play) {
        // Limit jumps after the browser suspends frames in a background window.
        const delta = lastFrameTime === undefined ? 0 : Math.min((time - lastFrameTime) / 1000, 0.1)
        lastFrameTime = time
        if (play) stepPlay(delta)
        mixer?.update(delta)
      }
      if (disposed) return
      renderer.render(scene, camera)
      if (playing || play) render()
    })
  }

  function cancelFrame() {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  function changePlayback(enabled) {
    if (playing === enabled) return
    playing = enabled
    lastFrameTime = undefined
    if (!playing) cancelFrame()
    if (!disposed) onPlaybackChange?.(playing)
  }

  function finish(event) {
    if (event.action === action) changePlayback(false)
  }

  function startAction(clip, repeat, paused = false) {
    const next = mixer.clipAction(clip).reset().setLoop(repeat ? LoopRepeat : LoopOnce, repeat ? Infinity : 1).play()
    next.clampWhenFinished = true
    next.setEffectiveTimeScale(1)
    next.paused = paused
    return next
  }

  function selectClip(index) {
    const clip = clips[index]
    if (play || !clip || action?.getClip() === clip) return
    action?.stop()
    action = startAction(clip, loop, !playing)
    lastFrameTime = undefined
    // Sample the first pose even when playback is paused.
    mixer.update(0)
    render()
  }

  function setPlaying(enabled) {
    if (play || !action || playing === enabled) return
    if (enabled && action.time >= action.getClip().duration) action.reset().play()
    action.paused = !enabled
    changePlayback(enabled)
    render()
  }

  function setLoop(enabled) {
    if (play || loop === enabled) return
    loop = enabled
    if (!action) return
    const time = action.time
    // Reset the loop counter while keeping the pose and pause state.
    action = startAction(action.getClip(), loop, !playing)
    action.time = time
  }

  function setMotion(motion) {
    if (play.motion === motion) return
    play.motion = motion
    play.action?.stop()
    const clip = locomotion[motion] ?? locomotion.walk
    play.action = startAction(clip, motion !== 'jump', motion === 'idle' && !locomotion.idle)
    if (motion === 'jump') play.action.timeScale = clip.duration / JUMP_SECONDS
    if (motion === 'run' && !locomotion.run) play.action.timeScale = 1.6
  }

  function stepPlay(delta) {
    const { keys, pivot, limit, height } = play
    const forward = Number(keys.has('KeyW')) - Number(keys.has('KeyS'))
    const right = Number(keys.has('KeyD')) - Number(keys.has('KeyA'))
    const moving = forward !== 0 || right !== 0
    const running = play.shiftDown || keys.has('ShiftLeft') || keys.has('ShiftRight')
    if (moving) {
      const view = Math.atan2(controls.target.x - camera.position.x, controls.target.z - camera.position.z)
      const heading = view - Math.atan2(right, forward)
      const distance = delta * height * (running ? 2.5 : 1.1)
      const x = MathUtils.clamp(pivot.position.x + Math.sin(heading) * distance, -limit, limit)
      const z = MathUtils.clamp(pivot.position.z + Math.cos(heading) * distance, -limit, limit)
      camera.position.x += x - pivot.position.x
      camera.position.z += z - pivot.position.z
      controls.target.x += x - pivot.position.x
      controls.target.z += z - pivot.position.z
      pivot.position.x = x
      pivot.position.z = z
      pivot.rotation.y = heading
      controls.update()
    }

    if (play.jumpRequested && play.jumpTime === undefined) play.jumpTime = 0
    play.jumpRequested = false
    if (play.jumpTime !== undefined) {
      const progress = Math.min((play.jumpTime += delta) / JUMP_SECONDS, 1)
      pivot.position.y = height * 1.4 * progress * (1 - progress)
      if (progress === 1) play.jumpTime = undefined
    }
    if (locomotion) {
      setMotion(play.jumpTime !== undefined && locomotion.jump ? 'jump' : moving ? (running ? 'run' : 'walk') : 'idle')
    }
  }

  function onBlur() {
    if (play) exitPlay(true)
  }

  function onKeyDown(event) {
    if (!play || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
    if (event.code !== 'Escape' && !PLAY_KEYS.has(event.code)) return
    event.preventDefault()
    event.stopPropagation()
    // A held Shift may be reported with the movement key, without its own keydown.
    play.shiftDown = event.shiftKey
    if (event.repeat) return
    if (event.code === 'Escape') {
      setPlayMode(false)
      return
    }
    if (event.code === 'Space' && !play.keys.has(event.code)) play.jumpRequested = true
    play.keys.add(event.code)
  }

  function onKeyUp(event) {
    if (!play || !PLAY_KEYS.has(event.code)) return
    play.shiftDown = event.shiftKey
    if (play.keys.delete(event.code)) event.stopPropagation()
  }

  function exitPlay(restorePreview, restoreFocus = false) {
    const state = play
    play = undefined
    cancelFrame()
    lastFrameTime = undefined
    canvas.removeEventListener('keydown', onKeyDown)
    canvas.removeEventListener('keyup', onKeyUp)
    canvas.removeEventListener('blur', onBlur)
    canvas.ownerDocument.defaultView?.removeEventListener('blur', onBlur)
    canvas.removeAttribute('tabindex')
    state.action?.stop()
    model.scene.removeFromParent()
    scene.remove(state.grid, state.pivot)
    state.grid.geometry.dispose()
    state.grid.material.dispose()

    if (restorePreview) {
      scene.add(model.scene)
      if (skeletonHelper) {
        scene.add(skeletonHelper)
        skeletonHelper.visible = true
      }
      if (state.clip) {
        action = startAction(state.clip, loop, !state.playing)
        action.time = state.time
        mixer.update(0)
      }
      camera.position.fromArray(state.previewView.position)
      controls.target.fromArray(state.previewView.target)
      camera.near = state.near
      camera.far = state.far
      controls.minDistance = state.minDistance
      controls.maxDistance = state.maxDistance
      if (comparisonBounds && camera.aspect !== state.previewView.aspect) {
        scaleComparisonView(state.previewView.aspect)
      }
      camera.updateProjectionMatrix()
      controls.update()
      changePlayback(state.playing)
      render()
    }
    if (!disposed) onPlayModeChange?.(false, { restoreFocus })
  }

  function setPlayMode(enabled) {
    if (enabled === Boolean(play) || disposed) return Boolean(play)
    if (!enabled) {
      exitPlay(true, true)
      return false
    }
    if (!model) return false
    if (skeletonHelper) skeletonHelper.visible = false

    const box = new Box3().setFromObject(model.scene)
    const scale = PLAY_RADIUS / bounds.radius
    const modelHeight = (box.max.y - box.min.y) * scale
    const height = Math.max(modelHeight, PLAY_RADIUS * 0.25)
    const limit = Math.max(height * 4, PLAY_RADIUS * 2)
    const pivot = new Group()
    const offset = new Group()
    // Normalize in the wrapper so neither the saved preview transform nor the authored clips change.
    offset.scale.setScalar(scale)
    box.getCenter(offset.position).setY(box.min.y).multiplyScalar(-scale)
    offset.add(model.scene)
    pivot.add(offset)
    const grid = new GridHelper(2.3 * limit, 16, 0x7c8490, 0x586370)
    grid.position.y = -height * 0.005
    scene.add(pivot, grid)

    play = {
      modelHeight, height, limit, pivot, grid, keys: new Set(),
      clip: action?.getClip(), time: action?.time, playing,
      previewView: captureView(),
      near: camera.near, far: camera.far, minDistance: controls.minDistance, maxDistance: controls.maxDistance,
    }
    action?.stop()
    action = undefined
    changePlayback(false)
    lastFrameTime = undefined
    if (locomotion) {
      setMotion('idle')
      mixer.update(0)
    }
    reset()

    canvas.tabIndex = 0
    canvas.addEventListener('keydown', onKeyDown)
    canvas.addEventListener('keyup', onKeyUp)
    canvas.addEventListener('blur', onBlur)
    canvas.ownerDocument.defaultView?.addEventListener('blur', onBlur)
    canvas.focus({ preventScroll: true })
    onPlayModeChange?.(true)
    return true
  }

  function fitDistance(aspect = camera.aspect) {
    const vertical = camera.fov * Math.PI / 360
    const horizontal = Math.atan(Math.tan(vertical) * aspect)
    const radius = play ? PLAY_RADIUS * 1.55 : (comparisonBounds ?? bounds).radius
    return radius * 1.12 / Math.sin(Math.min(vertical, horizontal))
  }

  function captureView() {
    if (!model || disposed) return
    if (play) return structuredClone(play.previewView)
    const reference = comparisonBounds ?? bounds
    return {
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      aspect: camera.aspect,
      reference: { center: reference.center.toArray(), radius: reference.radius },
    }
  }

  function scaleComparisonView(previousAspect) {
    const distance = fitDistance()
    if (camera.aspect !== previousAspect) {
      camera.position.sub(controls.target).multiplyScalar(distance / fitDistance(previousAspect)).add(controls.target)
    }
    const viewedDistance = controls.getDistance()
    controls.minDistance = Math.min(comparisonBounds.radius * 0.1, viewedDistance)
    controls.maxDistance = Math.max(distance * 8, viewedDistance)
    camera.near = Math.min(comparisonBounds.radius * 0.01, viewedDistance * 0.1)
    // Keep the reference framing even when a related model has different bounds.
    camera.far = Math.max(controls.maxDistance * 2, controls.maxDistance + controls.target.distanceTo(bounds.center) + bounds.radius)
  }

  function restoreView(view) {
    controls.target.fromArray(view.target)
    camera.position.fromArray(view.position)
    scaleComparisonView(view.aspect)
    camera.updateProjectionMatrix()
    controls.update()
    render()
  }

  function resize() {
    const width = host.clientWidth
    const height = host.clientHeight
    if (disposed || !width || !height) return
    const previousAspect = camera.aspect
    camera.aspect = width / height
    const distance = bounds ? fitDistance() : 0
    if (comparisonBounds && !play) {
      scaleComparisonView(previousAspect)
      controls.update()
    } else if (camera.aspect < previousAspect && controls.getDistance() < distance) {
      camera.position.sub(controls.target).setLength(distance).add(controls.target)
      controls.maxDistance = distance * 8
      camera.far = controls.maxDistance * 2
      controls.update()
    }
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
    render()
  }

  function reset() {
    if (!bounds || disposed) return
    const distance = fitDistance()
    const reference = comparisonBounds ?? bounds
    const radius = play ? PLAY_RADIUS : reference.radius
    if (play) controls.target.set(play.pivot.position.x, play.modelHeight / 2, play.pivot.position.z)
    else controls.target.copy(reference.center)
    controls.minDistance = radius * 0.1
    controls.maxDistance = distance * 8
    camera.position.copy(controls.target).addScaledVector(direction, distance)
    camera.near = radius * 0.01
    camera.far = controls.maxDistance * 2
    if (comparisonBounds && !play) scaleComparisonView(camera.aspect)
    camera.updateProjectionMatrix()
    controls.update()
    render()
  }

  function setWireframe(enabled) {
    wireframe = enabled
    model?.scene.traverse(object => {
      if (!object.isMesh) return
      for (const material of [object.material].flat()) material.wireframe = enabled
    })
    render()
  }

  function setSkeletonVisible(enabled) {
    if (enabled === Boolean(skeletonHelper) || (enabled && (!model || disposed || play))) return
    if (enabled) {
      skeletonHelper = new SkeletonHelper(model.scene)
      skeletonHelper.frustumCulled = false
      skeletonHelper.renderOrder = 1
      scene.add(skeletonHelper)
    } else {
      skeletonHelper.removeFromParent()
      skeletonHelper.dispose()
      skeletonHelper = undefined
    }
    render()
  }

  function removeModel() {
    if (!model) return
    if (play) exitPlay(false)
    setSkeletonVisible(false)
    if (mixer) {
      mixer.removeEventListener('finished', finish)
      mixer.stopAllAction()
      mixer.uncacheRoot(model.scene)
      mixer = undefined
      action = undefined
      clips = []
      locomotion = undefined
    }
    scene.remove(model.scene)
    releaseScenes(model.scenes)
    model = undefined
    changePlayback(false)
  }

  controls.addEventListener('change', render)
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  resize()

  return {
    async load(bytes, { view } = {}) {
      if (disposed) throw new DOMException('Preview closed.', 'AbortError')
      const loadRevision = ++revision
      validateGlb(bytes)
      const loaded = await loader.parseAsync(bytes, '')
      if (disposed || loadRevision !== revision) {
        releaseScenes(loaded.scenes)
        throw new DOMException('Preview superseded.', 'AbortError')
      }

      let triangles = 0
      let vertices = 0
      const bones = new Set()
      loaded.scene.traverse(object => {
        if (!object.isMesh) return
        if (object.isSkinnedMesh) for (const joint of object.skeleton.bones) bones.add(joint)
        const positionCount = object.geometry.attributes.position?.count ?? 0
        const instances = object.isInstancedMesh ? object.count : 1
        vertices += positionCount * instances
        triangles += Math.floor((object.geometry.index?.count ?? positionCount) / 3) * instances
      })
      const nextBounds = new Box3().setFromObject(loaded.scene).getBoundingSphere(new Sphere())
      if (!triangles || !Number.isFinite(nextBounds.radius) || nextBounds.radius <= 0) {
        releaseScenes(loaded.scenes)
        throw new Error('This GLB contains no renderable geometry.')
      }

      removeModel()
      model = loaded
      bounds = nextBounds
      comparisonBounds = view ? new Sphere(new Vector3().fromArray(view.reference.center), view.reference.radius) : undefined
      scene.add(model.scene)
      clips = loaded.animations.filter(clip => clip.tracks.length && Number.isFinite(clip.duration) && clip.duration > 0)
      locomotion = locomotionClips(clips)
      if (clips.length) {
        mixer = new AnimationMixer(model.scene)
        mixer.addEventListener('finished', finish)
        selectClip(0)
      }
      setWireframe(wireframe)
      if (view) restoreView(view)
      else reset()
      return {
        triangles,
        vertices,
        boneCount: bones.size,
        clips: clips.map(clip => ({ name: clip.name, duration: clip.duration })),
        canPlay: true,
      }
    },
    captureView,
    reset,
    setWireframe,
    setSkeletonVisible,
    selectClip,
    setPlaying,
    setLoop,
    setPlayMode,
    dispose() {
      if (disposed) return
      disposed = true
      cancelFrame()
      observer.disconnect()
      controls.removeEventListener('change', render)
      controls.dispose()
      removeModel()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
