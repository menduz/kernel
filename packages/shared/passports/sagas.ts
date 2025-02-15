import { call, put, race, select, take, takeEvery, takeLatest } from 'redux-saga/effects'
import { getServerConfigurations } from '../../config'
import { getAccessToken, getCurrentUserId, getEmail } from '../auth/selectors'
import defaultLogger from '../logger'
import { isInitialized } from '../renderer/selectors'
import { RENDERER_INITIALIZED } from '../renderer/types'
import {
  addCatalog,
  AddCatalogAction,
  ADD_CATALOG,
  catalogLoaded,
  CATALOG_LOADED,
  inventoryFailure,
  InventoryRequest,
  inventoryRequest,
  inventorySuccess,
  InventorySuccess,
  INVENTORY_FAILURE,
  INVENTORY_REQUEST,
  INVENTORY_SUCCESS,
  passportRandom,
  PassportRandomAction,
  PassportRequestAction,
  passportSuccess,
  PassportSuccessAction,
  PASSPORT_RANDOM,
  PASSPORT_REQUEST,
  PASSPORT_SUCCESS,
  saveAvatarFailure,
  SaveAvatarRequest,
  saveAvatarSuccess,
  SAVE_AVATAR_REQUEST,
  setProfileServer,
  passportRequest
} from './actions'
import { generateRandomUserProfile } from './generateRandomUserProfile'
import { baseCatalogsLoaded, getProfile, getProfileDownloadServer } from './selectors'
import { processServerProfile } from './transformations/processServerProfile'
import { profileToRendererFormat } from './transformations/profileToRendererFormat'
import { ensureServerFormat } from './transformations/profileToServerFormat'
import { Avatar, Catalog, Profile } from './types'

/**
 * This saga handles both passports and assets required for the renderer to show the
 * users' inventory and avatar editor.
 *
 * When the renderer is initialized, it will fetch the asset catalog and submit it to the renderer.
 *
 * Whenever a passport is requested, it will fetch it and store it locally (see also: `selectors.ts`)
 *
 * If a user avatar was not found, it will create a random passport (see: `handleRandomAsSuccess`)
 *
 * Lastly, we handle save requests by submitting both to the avatar legacy server as well as to the profile server.
 *
 * It's *very* important for the renderer to never receive a passport with items that have not been loaded into the catalog.
 */
export function* passportSaga(): any {
  yield put(setProfileServer(getServerConfigurations().profile))
  yield takeEvery(RENDERER_INITIALIZED, initialLoad)

  yield takeLatest(ADD_CATALOG, handleAddCatalog)

  yield takeLatest(PASSPORT_REQUEST, handleFetchProfile)
  yield takeLatest(PASSPORT_SUCCESS, submitPassportToRenderer)
  yield takeLatest(PASSPORT_RANDOM, handleRandomAsSuccess)

  yield takeLatest(SAVE_AVATAR_REQUEST, handleSaveAvatar)

  yield takeLatest(INVENTORY_REQUEST, handleFetchInventory)
}

export function* initialLoad() {
  try {
    const baseAvatars = yield call(fetchCatalog, 'https://dcl-base-avatars.now.sh/expected.json')
    const baseExclusive = yield call(fetchCatalog, 'https://dcl-base-exclusive.now.sh/expected.json')
    if (!(yield select(isInitialized))) {
      yield take(RENDERER_INITIALIZED)
    }
    yield put(addCatalog('base-avatars', baseAvatars))
    yield put(addCatalog('base-exclusive', baseExclusive))
  } catch (error) {
    defaultLogger.error('[FATAL]: Could not load catalog!', error)
  }
}

export function* handleFetchProfile(action: PassportRequestAction): any {
  const userId = action.payload.userId
  try {
    const serverUrl = yield select(getProfileDownloadServer)
    const accessToken = yield select(getAccessToken)
    const profile = yield call(profileServerRequest, serverUrl, userId, accessToken)
    const currentId = yield select(getCurrentUserId)
    if (currentId === userId) {
      profile.email = yield select(getEmail)
    }
    if (profile.ethAddress) {
      yield put(inventoryRequest(userId, profile.ethAddress))
      const inventoryResult = yield race({
        success: take(INVENTORY_SUCCESS),
        failure: take(INVENTORY_FAILURE)
      })
      if (inventoryResult.failure) {
        defaultLogger.error(`Unable to fetch inventory for ${userId}:`, inventoryResult.failure)
      } else {
        profile.inventory = (inventoryResult.success as InventorySuccess).payload.inventory.map(dropIndexFromExclusives)
      }
    } else {
      profile.inventory = []
    }
    const passport = processServerProfile(userId, profile)
    yield put(passportSuccess(userId, passport))
  } catch (error) {
    const randomizedUserProfile = yield call(generateRandomUserProfile, userId)
    const currentId = yield select(getCurrentUserId)
    if (currentId === userId) {
      randomizedUserProfile.email = yield select(getEmail)
    }
    yield put(inventorySuccess(userId, randomizedUserProfile.inventory))
    yield put(passportRandom(userId, randomizedUserProfile))
  }
}

export async function profileServerRequest(serverUrl: string, userId: string, accessToken: string) {
  try {
    const request = await fetch(`${serverUrl}/profile/${userId}`, {
      headers: {
        Authorization: 'Bearer ' + accessToken
      }
    })
    if (!request.ok) {
      throw new Error('Profile not found')
    }
    return await request.json()
  } catch (up) {
    throw up
  }
}

export function* handleRandomAsSuccess(action: PassportRandomAction): any {
  // TODO (eordano, 16/Sep/2019): See if there's another way around people expecting PASSPORT_SUCCESS
  yield put(passportSuccess(action.payload.userId, action.payload.profile))
}

export function* handleAddCatalog(action: AddCatalogAction): any {
  // TODO (eordano, 16/Sep/2019): Validate correct schema
  if (!action.payload.catalog) {
    return
  }
  if (!(yield select(isInitialized))) {
    yield take(RENDERER_INITIALIZED)
  }
  yield call(sendWearablesCatalog, action.payload.catalog)
  yield put(catalogLoaded(action.payload.name))
}

export async function fetchCatalog(url: string) {
  const request = await fetch(url)
  if (!request.ok) {
    throw new Error('Catalog not found')
  }
  return request.json()
}

declare var window: any

export function sendWearablesCatalog(catalog: Catalog) {
  window['unityInterface'].AddWearablesToCatalog(catalog)
}

export function* submitPassportToRenderer(action: PassportSuccessAction): any {
  if ((yield select(getCurrentUserId)) === action.payload.userId) {
    if (!(yield select(isInitialized))) {
      yield take(RENDERER_INITIALIZED)
    }
    while (!(yield select(baseCatalogsLoaded))) {
      yield take(CATALOG_LOADED)
    }
    yield call(sendLoadProfile, action.payload.profile)
  }
}

export function* sendLoadProfile(profile: Profile) {
  while (!(yield select(baseCatalogsLoaded))) {
    yield take(CATALOG_LOADED)
  }
  window['unityInterface'].LoadProfile(profileToRendererFormat(profile))
}

export function fetchCurrentProfile(accessToken: string, uuid: string) {
  const authHeader = {
    headers: {
      Authorization: 'Bearer ' + accessToken
    }
  }
  const request = `${getServerConfigurations().profile}/profile${uuid ? '/' + uuid : ''}`
  return fetch(request, authHeader)
}

export function* handleFetchInventory(action: InventoryRequest) {
  const { userId, ethAddress } = action.payload
  try {
    const inventoryItems = yield call(fetchInventoryItemsByAddress, ethAddress)
    yield put(inventorySuccess(userId, inventoryItems))
  } catch (error) {
    yield put(inventoryFailure(userId, error))
  }
}

function dropIndexFromExclusives(exclusive: string) {
  return exclusive
    .split('/')
    .slice(0, 4)
    .join('/')
}

export async function fetchInventoryItemsByAddress(address: string) {
  const result = await fetch(getServerConfigurations().wearablesApi + '/address/' + address)
  if (!result.ok) {
    throw new Error('Unable to fetch inventory for address ' + address)
  }
  return (await result.json()).inventory
}

export function* handleSaveAvatar(saveAvatar: SaveAvatarRequest) {
  const userId = saveAvatar.payload.userId ? saveAvatar.payload.userId : yield select(getCurrentUserId)
  try {
    const currentVersion = (yield select(getProfile, userId)).version || 0
    const accessToken = yield select(getAccessToken)
    const url = getServerConfigurations().profile + '/profile/' + userId + '/avatar'
    const result = yield call(modifyAvatar, {
      url,
      method: 'PUT',
      userId,
      currentVersion,
      accessToken,
      profile: saveAvatar.payload.profile
    })
    const { version } = result
    yield put(saveAvatarSuccess(userId, version))
    yield put(passportRequest(userId))
  } catch (error) {
    yield put(saveAvatarFailure(userId, 'unknown reason'))
  }
}

/**
 * @TODO (eordano, 16/Sep/2019): Upgrade the avatar schema on Profile Server
 */
export async function modifyAvatar(params: {
  url: string
  method: string
  currentVersion: number
  userId: string
  accessToken: string
  profile: { avatar: Avatar; face: string; body: string }
}) {
  const { url, method, currentVersion, profile, accessToken } = params
  const { face, avatar, body } = profile
  const snapshots = await saveSnapshots(
    getServerConfigurations().profile + '/profile/' + params.userId,
    accessToken,
    face,
    body
  )
  const avatarData: any = avatar
  avatarData.snapshots = snapshots
  const payload = JSON.stringify(ensureServerFormat(avatarData, currentVersion))
  const options = {
    method,
    body: payload,
    headers: {
      Authorization: 'Bearer ' + accessToken
    }
  }

  const response = await fetch(url, options)
  return response.json()
}

async function saveSnapshots(userURL: string, accessToken: string, face: string, body: string) {
  const data = new FormData()
  data.append('face', base64ToBlob(face), 'face.png')
  data.append('body', base64ToBlob(body), 'body.png')
  return (await fetch(`${userURL}/snapshot`, {
    method: 'POST',
    body: data,
    headers: {
      Authorization: 'Bearer ' + accessToken
    }
  })).json()
}

export function base64ToBlob(base64: string): Blob {
  const sliceSize = 1024
  const byteChars = window.atob(base64)
  const byteArrays = []
  let len = byteChars.length

  for (let offset = 0; offset < len; offset += sliceSize) {
    const slice = byteChars.slice(offset, offset + sliceSize)

    const byteNumbers = new Array(slice.length)
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i)
    }

    const byteArray = new Uint8Array(byteNumbers)

    byteArrays.push(byteArray)
    len = byteChars.length
  }

  return new Blob(byteArrays, { type: 'image/jpeg' })
}
